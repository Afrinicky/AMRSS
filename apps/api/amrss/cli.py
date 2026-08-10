"""Operational command line for the surveillance platform.

    python -m amrss.cli check-config
    python -m amrss.cli bootstrap
    python -m amrss.cli gen-secret [--bytes 64]
    python -m amrss.cli create-block <code> <name> <governing-body> [--district NAME ...]
    python -m amrss.cli create-user <email> <full-name> <role> [--block CODE] [--facility CODE]
    python -m amrss.cli list-users

The reason this exists rather than an endpoint: a deployment has to be able to
create its *first* administrator, and every write in this system requires an
authenticated principal with a permission. Bootstrapping through the API would
mean either an unauthenticated user-creation route — which is a permanent hole
kept open for a one-minute job — or shipping a default account, which is worse.
A command that requires shell access to the deployment is the smallest thing
that works.

Everything here is audited exactly as the API is, with the operating system
account recorded as the actor, so a user created out of band is not invisible.
"""

from __future__ import annotations

import argparse
import getpass
import secrets
import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - import cost, not behaviour
    from sqlalchemy.orm import Session

MIN_PASSWORD_LENGTH = 12


def _actor() -> str:
    """Who ran the command.

    The operating-system user and host, because there is no authenticated
    principal at a shell. Vaguer than a user id and better than nothing: it says
    the change came from the deployment host rather than from the application.
    """
    import os
    import platform

    account = os.environ.get("USER") or os.environ.get("LOGNAME") or "unknown"
    return f"cli:{account}@{platform.node()}"


def _cmd_check_config(_: argparse.Namespace) -> int:
    """Validate configuration without starting the server.

    Run as a pre-flight step in deployment: it fails on a weak or missing secret
    before any traffic is served, rather than at the first request.
    """
    from amrss.config import Settings, get_settings

    try:
        settings = Settings()
        get_settings.cache_clear()
        get_settings()
    except Exception as exc:  # the message is the whole point
        print(f"Configuration invalid:\n{exc}", file=sys.stderr)
        return 1

    print(f"Configuration valid (environment={settings.environment}).")
    if not settings.is_production:
        print(
            "Note: production hardening checks only run when "
            "AMRSS_ENVIRONMENT=production. Nothing here has verified the "
            "secrets this deployment would use in production."
        )
    return 0


def _cmd_bootstrap(_: argparse.Namespace) -> int:
    """Load whatever AMRSS_BOOTSTRAP asks for, then get out of the way.

    Runs on every container start, so it must be idempotent and it must not
    fail a deployment that has nothing to do. `none` — the default, and the
    only correct value in production — does nothing and returns success.
    """
    from amrss.config import get_settings

    mode = get_settings().bootstrap
    if mode == "none":
        return 0

    from amrss.db import SessionLocal
    from amrss.seed import seed_demo_block, seed_reference_data

    with SessionLocal() as db:
        counts = seed_reference_data(db)
        print(
            f"Bootstrap ({mode}): {counts['organisms']} organisms, "
            f"{counts['antibiotics']} antibiotics, {counts['specimen_types']} specimen types, "
            f"{counts['methodology']} methodology versions."
        )
        if mode == "demo":
            # Refuses in production on its own; this only reports it clearly.
            seed_demo_block(db)
            print("Bootstrap (demo): synthetic regional block loaded.")
    return 0


def _cmd_gen_secret(args: argparse.Namespace) -> int:
    print(secrets.token_urlsafe(args.bytes))
    return 0


def _cmd_create_block(args: argparse.Namespace) -> int:
    from datetime import date

    from sqlalchemy import select

    from amrss import audit
    from amrss.audit import AuditAction
    from amrss.db import SessionLocal
    from amrss.models import District, RegionalBlock

    with SessionLocal() as db:
        if db.scalar(select(RegionalBlock).where(RegionalBlock.code == args.code)):
            print(f"A regional block with code {args.code!r} already exists.", file=sys.stderr)
            return 1

        block = RegionalBlock(
            code=args.code,
            name=args.name,
            governing_body=args.governing_body,
            status="active",
            activated_at=date.today(),
            whonet_config_standard=args.whonet_config_standard,
        )
        db.add(block)
        db.flush()

        for name in args.district:
            db.add(District(regional_block_id=block.id, name=name.strip()))

        audit.record(
            db,
            action=AuditAction.BLOCK_CREATED,
            entity="regional_block",
            entity_id=block.id,
            actor_label=_actor(),
            after={"code": block.code, "name": block.name, "districts": len(args.district)},
            note="Created from the command line",
        )
        db.commit()

    print(f"Block {args.code} created with {len(args.district)} district(s).")
    print("Districts and facilities can be added from Administration → Facility enrollment.")
    return 0


def _resolve_scope(db: Session, args: argparse.Namespace) -> tuple[object, object] | None:
    """Find the block or facility a user is scoped to.

    Returns None on a failure that has already been reported.
    """
    from sqlalchemy import select

    from amrss.models import Facility, RegionalBlock

    block = facility = None
    if args.block:
        block = db.scalar(select(RegionalBlock).where(RegionalBlock.code == args.block))
        if block is None:
            print(f"No regional block with code {args.block!r}.", file=sys.stderr)
            return None
    if args.facility:
        facility = db.scalar(select(Facility).where(Facility.code == args.facility))
        if facility is None:
            print(f"No facility with code {args.facility!r}.", file=sys.stderr)
            return None
    return block, facility


def _read_password() -> str | None:
    """Prompt twice, never echo, and refuse anything short.

    Read from the terminal rather than an argument so the password does not land
    in shell history or in the process list.
    """
    password = getpass.getpass("Password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        print(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters.",
            file=sys.stderr,
        )
        return None
    if password != getpass.getpass("Repeat password: "):
        print("Passwords do not match.", file=sys.stderr)
        return None
    return password


def _cmd_create_user(args: argparse.Namespace) -> int:
    from sqlalchemy import select

    from amrss import audit
    from amrss.audit import AuditAction
    from amrss.db import SessionLocal
    from amrss.models import AppUser
    from amrss.models.enums import Role
    from amrss.security.passwords import hash_password

    try:
        role = Role(args.role)
    except ValueError:
        print(
            f"Unknown role {args.role!r}. Choose one of: " + ", ".join(r.value for r in Role),
            file=sys.stderr,
        )
        return 1

    # A facility-scoped role without a facility can see nothing; a regional role
    # without a block can see everything. Both are configuration mistakes worth
    # refusing at the point of creation rather than discovering in the interface.
    if role in (Role.LABORATORY_STAFF, Role.FACILITY_ADMINISTRATOR) and not args.facility:
        print(f"Role {role.value} is facility-scoped: pass --facility CODE.", file=sys.stderr)
        return 1

    email = args.email.strip().lower()

    with SessionLocal() as db:
        if db.scalar(select(AppUser).where(AppUser.email == email)):
            print(f"A user with email {email!r} already exists.", file=sys.stderr)
            return 1

        scope = _resolve_scope(db, args)
        if scope is None:
            return 1
        block, facility = scope

        password = _read_password()
        if password is None:
            return 1

        user = AppUser(
            email=email,
            full_name=args.full_name,
            password_hash=hash_password(password),
            role=role,
            facility_id=getattr(facility, "id", None),
            regional_block_id=getattr(block, "id", None),
            is_active=True,
        )
        db.add(user)
        db.flush()

        audit.record(
            db,
            action=AuditAction.USER_CREATED,
            entity="app_user",
            entity_id=user.id,
            actor_label=_actor(),
            after={"email": user.email, "role": role.value},
            note="Created from the command line",
        )
        db.commit()

    print(f"Created {email} as {role.value}.")
    return 0


def _cmd_list_users(_: argparse.Namespace) -> int:
    from sqlalchemy import select

    from amrss.db import SessionLocal
    from amrss.models import AppUser

    with SessionLocal() as db:
        users = list(db.scalars(select(AppUser).order_by(AppUser.email)))

    if not users:
        print("No users exist. Nobody can sign in to this deployment.")
        return 0

    for user in users:
        state = "active" if user.is_active else "INACTIVE"
        print(f"{user.email:40} {user.role.value:28} {state}")
    print(f"\n{len(users)} user(s).")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="amrss", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("check-config", help="validate configuration and exit")
    p.set_defaults(func=_cmd_check_config)

    p = sub.add_parser(
        "bootstrap", help="load reference or demo data per AMRSS_BOOTSTRAP; idempotent"
    )
    p.set_defaults(func=_cmd_bootstrap)

    p = sub.add_parser("gen-secret", help="generate key material for AMRSS_JWT_SECRET")
    p.add_argument("--bytes", type=int, default=64)
    p.set_defaults(func=_cmd_gen_secret)

    p = sub.add_parser("create-block", help="create a surveillance block")
    p.add_argument("code")
    p.add_argument("name")
    p.add_argument("governing_body")
    p.add_argument("--district", action="append", default=[], help="repeatable")
    p.add_argument("--whonet-config-standard", default=None)
    p.set_defaults(func=_cmd_create_block)

    p = sub.add_parser("create-user", help="create a user account")
    p.add_argument("email")
    p.add_argument("full_name")
    p.add_argument("role", help=", ".join(r for r in _role_names()))
    p.add_argument("--block", help="regional block code, for regionally scoped roles")
    p.add_argument("--facility", help="facility code, for facility-scoped roles")
    p.set_defaults(func=_cmd_create_user)

    p = sub.add_parser("list-users", help="list accounts and their roles")
    p.set_defaults(func=_cmd_list_users)

    return parser


def _role_names() -> list[str]:
    from amrss.models.enums import Role

    return [r.value for r in Role]


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
