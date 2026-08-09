"""PDF rendering of a report.

Formatting only, on the same terms as the Excel renderer: withheld cells arrive
carrying nothing to print.

Two layout decisions are driven by how these documents are actually used. AMR
reports get printed and passed round a stewardship meeting, so the page is
landscape A4 and the antibiogram splits across pages by *agent* rather than
shrinking to fit — a fifteen-agent panel squeezed onto one page is unreadable at
arm's length, and unreadable is worse than continued overleaf. And the coverage
statement sits on the first page above the table, not at the back, because a
reader who does not know one laboratory in seven was excluded cannot judge the
figures they are about to read.
"""

import io
from collections.abc import Callable
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from amrss.reports.build import ReportContent

BRAND = colors.HexColor("#1F7A4C")
INK = colors.HexColor("#12211A")
MUTED = colors.HexColor("#5C6B64")
LINE = colors.HexColor("#DCE7E1")
WITHHELD_BG = colors.HexColor("#EDEFEE")

#: Agents per page. Chosen so a printed cell stays legible at arm's length in a
#: meeting room rather than to minimise page count.
AGENTS_PER_PAGE = 8


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "title",
            parent=base["Title"],
            fontSize=16,
            textColor=INK,
            alignment=TA_LEFT,
            spaceAfter=2 * mm,
        ),
        "scope": ParagraphStyle(
            "scope", parent=base["Normal"], fontSize=10.5, textColor=BRAND, spaceAfter=1 * mm
        ),
        "muted": ParagraphStyle(
            "muted", parent=base["Normal"], fontSize=8, textColor=MUTED, leading=11
        ),
        "body": ParagraphStyle(
            "body", parent=base["Normal"], fontSize=9, textColor=INK, leading=12
        ),
        "heading": ParagraphStyle(
            "heading",
            parent=base["Heading2"],
            fontSize=11.5,
            textColor=INK,
            spaceBefore=5 * mm,
            spaceAfter=2 * mm,
        ),
        "cellHeader": ParagraphStyle(
            "cellHeader",
            parent=base["Normal"],
            fontSize=7.5,
            textColor=colors.white,
            leading=9,
            alignment=1,
        ),
        "framing": ParagraphStyle(
            "framing",
            parent=base["Normal"],
            fontSize=8.5,
            textColor=INK,
            leading=12,
            borderPadding=4,
            backColor=colors.HexColor("#EAF6EF"),
        ),
    }


def render(content: ReportContent) -> bytes:
    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=12 * mm,
        bottomMargin=14 * mm,
        title=content.title,
        author="AMRSS",
    )
    style = _styles()
    story: list = [
        Paragraph(content.title, style["title"]),
        Paragraph(
            f"{content.scope_label} &nbsp;·&nbsp; "
            f"{content.period_start:%d %b %Y} to {content.period_end:%d %b %Y}",
            style["scope"],
        ),
        Paragraph(
            f"Generated {content.generated_at:%d %b %Y %H:%M} UTC. "
            f"{content.eligible_isolate_count:,} antibiogram-eligible isolates of "
            f"{content.raw_isolate_count:,} in period.",
            style["muted"],
        ),
        Spacer(1, 4 * mm),
        _coverage_block(content, style),
        Spacer(1, 4 * mm),
    ]

    if not content.rows:
        story.append(
            Paragraph(
                "No organism-agent combination reached the reporting threshold in this "
                "period, so no antibiogram is published. This is a statement about the "
                "volume of data, not about resistance.",
                style["body"],
            )
        )
    else:
        chunks = [
            content.antibiotics[i : i + AGENTS_PER_PAGE]
            for i in range(0, len(content.antibiotics), AGENTS_PER_PAGE)
        ]
        for index, chunk in enumerate(chunks):
            offset = index * AGENTS_PER_PAGE
            if index:
                story.append(PageBreak())
            heading = (
                f"Percent susceptible — agents {offset + 1} to {offset + len(chunk)}"
                if len(chunks) > 1
                else "Percent susceptible"
            )
            story.append(Paragraph(heading, style["heading"]))
            story.append(_antibiogram_table(content, chunk, offset, style))

    story.append(Spacer(1, 4 * mm))
    story.append(
        KeepTogether(
            [
                Paragraph("How these figures were produced", style["heading"]),
                *[Paragraph(f"• {note}", style["muted"]) for note in content.notes],
            ]
        )
    )

    if content.signals:
        story.append(
            KeepTogether(
                [
                    Paragraph("Emerging resistance signals", style["heading"]),
                    Paragraph(
                        "Screening prompts for expert review, not confirmed outbreaks. Kept "
                        "apart from the antibiogram because they do not meet the reporting "
                        "threshold.",
                        style["muted"],
                    ),
                    Spacer(1, 2 * mm),
                    *[Paragraph(f"• {line}", style["body"]) for line in content.signals],
                ]
            )
        )

    story.append(Spacer(1, 5 * mm))
    story.append(Paragraph(content.clinical_framing, style["framing"]))

    document.build(story, onFirstPage=_furniture(content), onLaterPages=_furniture(content))
    return buffer.getvalue()


def _coverage_block(content: ReportContent, style: dict[str, ParagraphStyle]) -> Table:
    """Coverage on the first page, above the table it qualifies."""
    completeness = f"{content.completeness_percent:.0f}%" if content.completeness_percent else "—"
    pairs = [
        (
            "Facilities contributing",
            f"{content.facilities_contributing} of {content.facilities_expected}",
        ),
        ("Completeness", completeness),
        ("Excluded on quality grounds", str(content.facilities_excluded_by_quality)),
        ("Reporting threshold", f"n ≥ {content.minimum_isolates}"),
        ("Data last updated", (content.data_last_updated or "Not recorded")[:10]),
    ]
    table = Table(
        [
            [Paragraph(label, style["muted"]) for label, _ in pairs],
            [Paragraph(f"<b>{value}</b>", style["body"]) for _, value in pairs],
        ],
        colWidths=[54 * mm] * len(pairs),
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F4F9F6")),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def _antibiogram_table(
    content: ReportContent,
    agents: list[str],
    offset: int,
    style: dict[str, ParagraphStyle],
) -> Table:
    header = [
        Paragraph("<b>Organism</b>", style["cellHeader"]),
        Paragraph("<b>Isolates</b>", style["cellHeader"]),
        *[Paragraph(f"<b>{agent}</b>", style["cellHeader"]) for agent in agents],
    ]
    body = [header]
    withheld_positions: list[tuple[int, int]] = []

    for row_index, row in enumerate(content.rows, start=1):
        line = [
            Paragraph(f"<i>{row.organism}</i>", style["body"]),
            Paragraph(str(row.isolate_count), style["body"]),
        ]
        for column_index, cell in enumerate(row.cells[offset : offset + len(agents)]):
            if cell.reportable:
                # n printed beneath the percentage: a percentage without its
                # denominator is not a statistic (SDD 11.3).
                line.append(
                    Paragraph(
                        f"<b>{cell.display}</b><br/><font size=6 color='#5C6B64'>"
                        f"{cell.n_display}</font>",
                        ParagraphStyle("c", parent=style["body"], alignment=1, leading=10),
                    )
                )
            else:
                line.append(
                    Paragraph(
                        "<font size=7 color='#6B7873'>—</font>",
                        ParagraphStyle("c", parent=style["body"], alignment=1),
                    )
                )
                withheld_positions.append((2 + column_index, row_index))
        body.append(line)

    table = Table(
        body,
        colWidths=[52 * mm, 18 * mm, *[22 * mm] * len(agents)],
        repeatRows=1,
    )
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        # Banding: these panels run wide and the eye loses the row otherwise.
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFCFB")]),
    ]
    commands.extend(
        ("BACKGROUND", position, position, WITHHELD_BG) for position in withheld_positions
    )
    table.setStyle(TableStyle(commands))
    return table


def _furniture(content: ReportContent) -> Callable[[Any, Any], None]:
    """Page number and provenance on every page.

    A single page separated from the document must still say what it is: a table
    of percentages with no scope and no period is a hazard, not a report.
    """

    def draw(canvas: Any, document: Any) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(
            12 * mm,
            8 * mm,
            f"AMRSS · {content.scope_label} · "
            f"{content.period_start:%d %b %Y} to {content.period_end:%d %b %Y} · "
            "Surveillance intelligence, not prescribing advice",
        )
        canvas.drawRightString(document.pagesize[0] - 12 * mm, 8 * mm, f"Page {document.page}")
        canvas.setStrokeColor(LINE)
        canvas.line(12 * mm, 11 * mm, document.pagesize[0] - 12 * mm, 11 * mm)
        canvas.restoreState()

    return draw
