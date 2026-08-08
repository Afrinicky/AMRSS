"""Operational command line.

python -m amrss.cli gen-key [--bytes 64]
python -m amrss.cli check-config
python -m amrss.cli verify-audit
python -m amrss.cli import-breakpoints <version> <edition> <file.csv>
python -m amrss.cli create-user <email> <full-name> <role>[,<role>...]
"""

from __future__ import annotations

import argparse
import csv
import getpass
import sys
from pathlib import Path

from amrss.core.crypto import generate_key


def _cmd_gen_key(args: argparse.Namespace) -> int:
    print(generate_key(args.bytes))
    return 0


def _cmd_check_config(_: argparse.Namespace) -> int:
    """Validate the environment without starting the server.

    Run this in deployment as a pre-flight step: it fails loudly on weak or
    missing secrets before any traffic is served.
    """
    from amrss.config import Settings

    try:
        settings = Settings()  # type: ignore[call-arg]
    except Exception as exc:  # noqa: BLE001 - the message is the whole point
        print(f"Configuration invalid:\n{exc}", file=sys.stderr)
        return 1
    print(f"Configuration valid (environment={settings.environment})")
    if not settings.is_production:
        print("Note: production hardening checks only run when environment=production")
    return 0


def _cmd_verify_audit(_: argparse.Namespace) -> int:
    from sqlalchemy import select

    from amrss.core.audit import verify_chain
    from amrss.db.models.audit import AuditLogEntry
    from amrss.db.session import session_scope

    with session_scope() as db:
        rows = list(db.scalars(select(AuditLogEntry).order_by(AuditLogEntry.seq)))

    ok, bad_index = verify_chain(rows)
    if ok:
        print(f"Audit chain intact across {len(rows)} entries.")
        return 0
    row = rows[bad_index] if bad_index is not None else None
    print(
        "AUDIT CHAIN BROKEN at "
        f"index {bad_index} (seq={getattr(row, 'seq', '?')}, "
        f"action={getattr(row, 'action', '?')}).\n"
        "Entries at or after this point have been altered, deleted or reordered.",
        file=sys.stderr,
    )
    return 2


def _cmd_import_breakpoints(args: argparse.Namespace) -> int:
    from amrss.db.session import session_scope
    from amrss.services import breakpoint_service

    path = Path(args.file)
    if not path.is_file():
        print(f"No such file: {path}", file=sys.stderr)
        return 1

    with path.open(newline="", encoding="utf-8") as handle:
        # Strip comment lines before parsing so the shipped template - which
        # documents each column inline - can be edited in place.
        lines = [line for line in handle if not line.lstrip().startswith("#")]
    rows = [
        {k: v for k, v in row.items() if k is not None}
        for row in csv.DictReader(lines)
        if any((v or "").strip() for v in row.values())
    ]
    if not rows:
        print(f"No data rows found in {path}", file=sys.stderr)
        return 1

    try:
        with session_scope() as db:
            record = breakpoint_service.import_set(
                db,
                version=args.version,
                source_edition=args.edition,
                rows=rows,
                actor_id=None,
                notes=args.notes,
            )
            count = len(rows)
            version = record.version
    except breakpoint_service.BreakpointImportError as exc:
        print(f"Import rejected - {exc}", file=sys.stderr)
        for issue in exc.issues[:50]:
            print(f"  row {issue.breakpoint_index}: {issue.message}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"Import failed: {exc}", file=sys.stderr)
        return 1

    print(f"Imported {count} breakpoints as '{version}' (inactive).")
    print("Review it against the printed tables, then activate:")
    print(f"  POST /api/v1/clsi/breakpoint-sets/{version}/activate")
    return 0


def _cmd_create_user(args: argparse.Namespace) -> int:
    from amrss.api.deps import get_password_hasher
    from amrss.core.audit import AuditAction
    from amrss.core.permissions import Role
    from amrss.db.models.user import User
    from amrss.db.session import session_scope
    from amrss.services import audit_service

    roles = [r.strip() for r in args.roles.split(",") if r.strip()]
    unknown = [r for r in roles if r not in {str(x) for x in Role}]
    if unknown:
        print(f"Unknown role(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"Valid roles: {', '.join(str(r) for r in Role)}", file=sys.stderr)
        return 1

    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Confirm password: "):
        print("Passwords do not match.", file=sys.stderr)
        return 1

    hasher = get_password_hasher()
    problems = hasher.validate_strength(password)
    if problems:
        print("Password rejected: " + "; ".join(problems), file=sys.stderr)
        return 1

    with session_scope() as db:
        user = User(
            email=args.email.strip().lower(),
            full_name=args.full_name,
            password_hash=hasher.hash(password),
            roles=roles,
            laboratory_code=args.laboratory,
        )
        db.add(user)
        db.flush()
        audit_service.record(
            db,
            action=AuditAction.USER_CREATED,
            target_type="user",
            target_id=str(user.id),
            detail={"roles": roles, "created_via": "cli"},
        )
        user_id = user.id

    print(f"Created user {args.email} ({user_id}) with roles: {', '.join(roles)}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="amrss", description="AMRSS operations")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("gen-key", help="generate base64url key material")
    p.add_argument("--bytes", type=int, default=64)
    p.set_defaults(func=_cmd_gen_key)

    p = sub.add_parser("check-config", help="validate configuration and exit")
    p.set_defaults(func=_cmd_check_config)

    p = sub.add_parser("verify-audit", help="verify the audit hash chain")
    p.set_defaults(func=_cmd_verify_audit)

    p = sub.add_parser("import-breakpoints", help="import a CLSI breakpoint table")
    p.add_argument("version")
    p.add_argument("edition")
    p.add_argument("file")
    p.add_argument("--notes", default=None)
    p.set_defaults(func=_cmd_import_breakpoints)

    p = sub.add_parser("create-user", help="create a user account")
    p.add_argument("email")
    p.add_argument("full_name")
    p.add_argument("roles", help="comma-separated role names")
    p.add_argument("--laboratory", default=None)
    p.set_defaults(func=_cmd_create_user)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
