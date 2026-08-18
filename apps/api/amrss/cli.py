"""Operational command line for the surveillance platform.

    python -m amrss.cli check-config
    python -m amrss.cli bootstrap
    python -m amrss.cli gen-secret [--bytes 64]
    python -m amrss.cli create-block <code> <name> <governing-body> [--district NAME ...]
    python -m amrss.cli create-user <email> <full-name> <role> [--block CODE] [--facility CODE]
    python -m amrss.cli list-users
    python -m amrss.cli reset-password <email-or-username> [--require-change]
    python -m amrss.cli import-breakpoints <version> <source-edition> <file.csv>

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
import pathlib
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


def _cmd_reset_password(args: argparse.Namespace) -> int:
    """Set an account's password from the host, and get it back into a usable state.

    The recovery path when the only administrator is locked out — a deactivated
    account, a forgotten password, or a lockout with no second administrator to
    clear it. Looks the account up by email or username, sets a new password read
    from the terminal, clears any lockout, and reactivates it. Unlike an in-app
    reset it does not force a change at next sign-in by default: whoever runs a
    host command already holds the credential they just set. Audited, with the
    operating-system account recorded as the actor.
    """
    from datetime import UTC, datetime

    from sqlalchemy import func, or_, select

    from amrss import audit
    from amrss.audit import AuditAction
    from amrss.db import SessionLocal
    from amrss.models import AppUser
    from amrss.security.passwords import hash_password

    identifier = args.identifier.strip().lower()

    with SessionLocal() as db:
        user = db.scalar(
            select(AppUser).where(
                or_(AppUser.email == identifier, func.lower(AppUser.username) == identifier)
            )
        )
        if user is None:
            print(f"No account with email or username {args.identifier!r}.", file=sys.stderr)
            return 1

        password = _read_password()
        if password is None:
            return 1

        user.password_hash = hash_password(password)
        user.password_changed_at = datetime.now(UTC)
        user.must_change_password = args.require_change
        # A recovery is also the answer to "locked out and cannot wait", and to an
        # account that was deactivated (including automatically, when its facility
        # was removed). Both are cleared so the reset actually restores access.
        user.locked_until = None
        user.failed_login_count = 0
        reactivated = not user.is_active
        user.is_active = True

        audit.record(
            db,
            action=AuditAction.USER_UPDATED,
            entity="app_user",
            entity_id=user.id,
            actor_label=_actor(),
            after={
                "password_reset": True,
                "reactivated": reactivated,
                "must_change_password": user.must_change_password,
            },
            note="Password reset from the command line",
        )
        db.commit()

        label = user.username or user.email
        print(f"Password reset for {label} ({user.role.value}).")
        if reactivated:
            print("The account was inactive and has been reactivated.")
        print("Sign in with either the email or the username.")
    return 0


def _cmd_import_breakpoints(args: argparse.Namespace) -> int:
    """Load a breakpoint table from the host.

    The same importer, the same validation and the same versioning the API
    endpoint uses — this is the shell entry to it, for a deployment being set up
    before anyone has a browser session, or one where the table is loaded by
    whoever runs the database rather than by an administrator clicking.

    A single validation error refuses the whole file. Accepting a table with
    three bad rows out of nine hundred would put three wrong thresholds into
    clinical reports, with no way afterwards to tell which results they touched.
    """
    from datetime import date

    from amrss import audit
    from amrss.analytics.breakpoint_import import BreakpointImportError, import_breakpoints
    from amrss.audit import AuditAction
    from amrss.db import SessionLocal

    path = pathlib.Path(args.file)
    if not path.exists():
        print(f"No such file: {path}", file=sys.stderr)
        return 1

    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        print(
            f"{path} is not UTF-8 text. A workbook has to be converted first — "
            "upload it through the API, or export it from your spreadsheet as CSV (UTF-8).",
            file=sys.stderr,
        )
        return 1

    effective = date.fromisoformat(args.effective_from) if args.effective_from else date.today()

    with SessionLocal() as db:
        try:
            result = import_breakpoints(
                db,
                text,
                version=args.version,
                source_edition=args.source_edition,
                effective_from=effective,
                description=args.description,
                commit=False,
            )
        except BreakpointImportError as exc:
            db.rollback()
            print(f"The table was not imported. {len(exc.problems)} problem(s):", file=sys.stderr)
            for problem in exc.problems[:40]:
                print(f"  {problem}", file=sys.stderr)
            if len(exc.problems) > 40:
                print(f"  … and {len(exc.problems) - 40} more", file=sys.stderr)
            return 1

        audit.record(
            db,
            action=AuditAction.BREAKPOINTS_IMPORTED,
            entity="methodology_version",
            actor_label=_actor(),
            after={
                "version": result.version,
                "source_edition": result.source_edition,
                "breakpoints": result.imported,
                "file": str(path),
            },
            note="Imported from the command line",
        )
        db.commit()

    print(f"Imported {result.imported} criteria as {result.version}, effective {effective}.")
    for warning in result.warnings[:20]:
        print(f"  warning: {warning}")
    if len(result.warnings) > 20:
        print(f"  … and {len(result.warnings) - 20} more warnings")
    print("Results interpreted on or after that date cite this version.")
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

    p = sub.add_parser(
        "reset-password",
        help="set a password by email or username, clearing any lockout and reactivating",
    )
    p.add_argument("identifier", help="the account's email address or username")
    p.add_argument(
        "--require-change",
        action="store_true",
        help="force the account to change the password at next sign-in",
    )
    p.set_defaults(func=_cmd_reset_password)

    p = sub.add_parser(
        "import-breakpoints",
        help="load a breakpoint table (template CSV) as a new, dated methodology version",
    )
    p.add_argument("version", help="e.g. M100-Ed36; stamped onto every figure computed with it")
    p.add_argument("source_edition", help='e.g. "CLSI M100 36th ed. (2026)"')
    p.add_argument("file", help="the template CSV, e.g. data/breakpoints/clsi_m100_ed36.csv")
    p.add_argument(
        "--effective-from",
        dest="effective_from",
        default=None,
        help="ISO date the table takes effect (default: today)",
    )
    p.add_argument("--description", default="", help="free text recorded with the version")
    p.set_defaults(func=_cmd_import_breakpoints)

    return parser


def _role_names() -> list[str]:
    from amrss.models.enums import Role

    return [r.value for r in Role]


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
