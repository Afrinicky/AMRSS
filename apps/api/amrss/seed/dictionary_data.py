"""Canonical dictionary reference data.

Regional-block-agnostic by design (SDD 3.4). Facilities map their local WHONET
codes into these entries; nothing here is specific to any region or facility.

Codes follow WHONET conventions where they exist, so that mapping an incoming
WHONET configuration is usually a confirmation rather than a translation.
"""

from typing import NotRequired, TypedDict

from amrss.models.enums import AntimicrobialClass, OrganismKingdom


class OrganismSeed(TypedDict):
    code: str
    name: str
    kingdom: OrganismKingdom
    genus: str | None
    family: str | None
    gram_stain: str | None
    is_enterobacterales: bool
    special_importance: bool
    #: Optional explicit CLSI organism groups, most specific first. Omitted for
    #: most organisms, where GENUS_CLSI_GROUPS derives them.
    clsi_groups: NotRequired[list[str]]


class AntibioticSeed(TypedDict):
    code: str
    name: str
    antimicrobial_class: AntimicrobialClass
    target_kingdom: OrganismKingdom
    who_aware_category: str | None
    display_order: int
    #: Optional agent code as it appears in the laboratory's CLSI table, where it
    #: differs from the dictionary code.
    clsi_agent_code: NotRequired[str]


#: Genus to CLSI organism group. CLSI M100 scopes its criteria by these group
#: names, and the mapping is data because it belongs to the dictionary, not to
#: the interpretation engine: a laboratory adding an organism, or CLSI
#: reorganising a table, must not require a code change (ADR-0002). The seeded
#: values are a starting point and are editable thereafter.
GENUS_CLSI_GROUPS: dict[str, list[str]] = {
    "Staphylococcus": ["Staphylococcus spp."],
    "Enterococcus": ["Enterococcus spp."],
    "Streptococcus": ["Streptococcus spp."],
    "Pseudomonas": ["Pseudomonas aeruginosa"],
    "Acinetobacter": ["Acinetobacter spp."],
    "Haemophilus": ["Haemophilus influenzae and Haemophilus parainfluenzae"],
    "Neisseria": ["Neisseria spp."],
    "Stenotrophomonas": ["Stenotrophomonas maltophilia"],
    "Burkholderia": ["Burkholderia cepacia complex"],
    "Campylobacter": ["Campylobacter jejuni/coli"],
    "Vibrio": ["Vibrio spp."],
    "Candida": ["Candida spp."],
    "Cryptococcus": ["Cryptococcus spp."],
    "Aspergillus": ["Aspergillus spp."],
}

#: Applied to every organism flagged is_enterobacterales, after its own species
#: and genus groups. M100 defines most Gram-negative criteria at this level.
ENTEROBACTERALES_GROUP = "Enterobacterales"


class SpecimenSeed(TypedDict):
    code: str
    name: str
    infection_site: str
    is_sterile_site: bool


#: ``special_importance`` seeds the below-threshold alert list (SDD 5.2). It is a
#: starting point only — SDD 13.5 leaves the definitive list to the clinical and
#: microbiology leads, and it is editable in the admin console thereafter.
ORGANISMS: list[OrganismSeed] = [
    # Enterobacterales
    {
        "code": "eco",
        "name": "Escherichia coli",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Escherichia",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": True,
    },
    {
        "code": "kpn",
        "name": "Klebsiella pneumoniae",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Klebsiella",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": True,
    },
    {
        "code": "kox",
        "name": "Klebsiella oxytoca",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Klebsiella",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "ent",
        "name": "Enterobacter cloacae complex",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Enterobacter",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "pmi",
        "name": "Proteus mirabilis",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Proteus",
        "family": "Morganellaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "sal",
        "name": "Salmonella species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Salmonella",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": True,
    },
    {
        "code": "shi",
        "name": "Shigella species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Shigella",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": True,
    },
    # Non-fermenting Gram negatives
    {
        "code": "pae",
        "name": "Pseudomonas aeruginosa",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Pseudomonas",
        "family": "Pseudomonadaceae",
        "gram_stain": "negative",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "aba",
        "name": "Acinetobacter baumannii complex",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Acinetobacter",
        "family": "Moraxellaceae",
        "gram_stain": "negative",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    # Gram positives
    {
        "code": "sau",
        "name": "Staphylococcus aureus",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Staphylococcus",
        "family": "Staphylococcaceae",
        "gram_stain": "positive",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "cns",
        "name": "Coagulase-negative Staphylococcus",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Staphylococcus",
        "family": "Staphylococcaceae",
        "gram_stain": "positive",
        "is_enterobacterales": False,
        "special_importance": False,
    },
    {
        "code": "spn",
        "name": "Streptococcus pneumoniae",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Streptococcus",
        "family": "Streptococcaceae",
        "gram_stain": "positive",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "efa",
        "name": "Enterococcus faecalis",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Enterococcus",
        "family": "Enterococcaceae",
        "gram_stain": "positive",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "efm",
        "name": "Enterococcus faecium",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Enterococcus",
        "family": "Enterococcaceae",
        "gram_stain": "positive",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    # Fungi — first-class, not an afterthought (SDD 5.6)
    {
        "code": "cal",
        "name": "Candida albicans",
        "kingdom": OrganismKingdom.FUNGI,
        "genus": "Candida",
        "family": "Debaryomycetaceae",
        "gram_stain": None,
        "is_enterobacterales": False,
        "special_importance": False,
    },
    {
        "code": "cgl",
        "name": "Nakaseomyces glabratus (Candida glabrata)",
        "kingdom": OrganismKingdom.FUNGI,
        "genus": "Nakaseomyces",
        "family": "Saccharomycetaceae",
        "gram_stain": None,
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "ctr",
        "name": "Candida tropicalis",
        "kingdom": OrganismKingdom.FUNGI,
        "genus": "Candida",
        "family": "Debaryomycetaceae",
        "gram_stain": None,
        "is_enterobacterales": False,
        "special_importance": False,
    },
    {
        "code": "cpa",
        "name": "Candida parapsilosis",
        "kingdom": OrganismKingdom.FUNGI,
        "genus": "Candida",
        "family": "Debaryomycetaceae",
        "gram_stain": None,
        "is_enterobacterales": False,
        "special_importance": False,
    },
    {
        "code": "cau",
        "name": "Candidozyma auris (Candida auris)",
        "kingdom": OrganismKingdom.FUNGI,
        "genus": "Candidozyma",
        "family": "Metschnikowiaceae",
        "gram_stain": None,
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "cne",
        "name": "Cryptococcus neoformans",
        "kingdom": OrganismKingdom.FUNGI,
        "genus": "Cryptococcus",
        "family": "Cryptococcaceae",
        "gram_stain": None,
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "kl-",
        "name": "Klebsiella species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Klebsiella",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": True,
    },
    {
        "code": "ci-",
        "name": "Citrobacter species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Citrobacter",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "en-",
        "name": "Enterobacter species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Enterobacter",
        "family": "Enterobacteriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "ps-",
        "name": "Pseudomonas species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Pseudomonas",
        "family": "Pseudomonadaceae",
        "gram_stain": "negative",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "pr-",
        "name": "Proteus species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Proteus",
        "family": "Morganellaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "ne-",
        "name": "Neisseria species",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Neisseria",
        "family": "Neisseriaceae",
        "gram_stain": "negative",
        "is_enterobacterales": False,
        "special_importance": False,
    },
    {
        "code": "pvu",
        "name": "Proteus vulgaris",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Proteus",
        "family": "Morganellaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "mmo",
        "name": "Morganella morganii",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Morganella",
        "family": "Morganellaceae",
        "gram_stain": "negative",
        "is_enterobacterales": True,
        "special_importance": False,
    },
    {
        "code": "sep",
        "name": "Staphylococcus epidermidis",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Staphylococcus",
        "family": "Staphylococcaceae",
        "gram_stain": "positive",
        "is_enterobacterales": False,
        "special_importance": False,
    },
    {
        "code": "bca",
        "name": "Burkholderia cepacia complex",
        "kingdom": OrganismKingdom.BACTERIA,
        "genus": "Burkholderia",
        "family": "Burkholderiaceae",
        "gram_stain": "negative",
        "is_enterobacterales": False,
        "special_importance": True,
    },
    {
        "code": "can",
        "name": "Candida species",
        "kingdom": OrganismKingdom.FUNGI,
        "genus": "Candida",
        "family": "Debaryomycetaceae",
        "gram_stain": None,
        "is_enterobacterales": False,
        "special_importance": False,
    },
]


ANTIBIOTICS: list[AntibioticSeed] = [
    {
        "code": "AMP",
        "name": "Ampicillin",
        "antimicrobial_class": AntimicrobialClass.PENICILLIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 10,
    },
    {
        "code": "PEN",
        "name": "Benzylpenicillin",
        "antimicrobial_class": AntimicrobialClass.PENICILLIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 11,
    },
    {
        "code": "OXA",
        "name": "Oxacillin",
        "antimicrobial_class": AntimicrobialClass.PENICILLIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 12,
    },
    {
        "code": "AMC",
        "name": "Amoxicillin-clavulanate",
        "antimicrobial_class": AntimicrobialClass.BETA_LACTAM_INHIBITOR,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 20,
    },
    {
        "code": "TZP",
        "name": "Piperacillin-tazobactam",
        "antimicrobial_class": AntimicrobialClass.BETA_LACTAM_INHIBITOR,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 21,
    },
    {
        "code": "CZO",
        "name": "Cefazolin",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 30,
    },
    {
        "code": "FOX",
        "name": "Cefoxitin",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 31,
    },
    {
        "code": "CRO",
        "name": "Ceftriaxone",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 32,
    },
    {
        "code": "CTX",
        "name": "Cefotaxime",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 33,
    },
    {
        "code": "CAZ",
        "name": "Ceftazidime",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 34,
    },
    {
        "code": "FEP",
        "name": "Cefepime",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 35,
    },
    {
        "code": "ETP",
        "name": "Ertapenem",
        "antimicrobial_class": AntimicrobialClass.CARBAPENEM,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 40,
    },
    {
        "code": "IPM",
        "name": "Imipenem",
        "antimicrobial_class": AntimicrobialClass.CARBAPENEM,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 41,
    },
    {
        "code": "MEM",
        "name": "Meropenem",
        "antimicrobial_class": AntimicrobialClass.CARBAPENEM,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 42,
    },
    {
        "code": "GEN",
        "name": "Gentamicin",
        "antimicrobial_class": AntimicrobialClass.AMINOGLYCOSIDE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 50,
    },
    {
        "code": "AMK",
        "name": "Amikacin",
        "antimicrobial_class": AntimicrobialClass.AMINOGLYCOSIDE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 51,
    },
    {
        "code": "CIP",
        "name": "Ciprofloxacin",
        "antimicrobial_class": AntimicrobialClass.FLUOROQUINOLONE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 60,
    },
    {
        "code": "LVX",
        "name": "Levofloxacin",
        "antimicrobial_class": AntimicrobialClass.FLUOROQUINOLONE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 61,
    },
    {
        "code": "ERY",
        "name": "Erythromycin",
        "antimicrobial_class": AntimicrobialClass.MACROLIDE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 70,
    },
    {
        "code": "CLI",
        "name": "Clindamycin",
        "antimicrobial_class": AntimicrobialClass.LINCOSAMIDE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 75,
    },
    {
        "code": "TCY",
        "name": "Tetracycline",
        "antimicrobial_class": AntimicrobialClass.TETRACYCLINE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 80,
    },
    {
        "code": "VAN",
        "name": "Vancomycin",
        "antimicrobial_class": AntimicrobialClass.GLYCOPEPTIDE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 90,
    },
    {
        "code": "LNZ",
        "name": "Linezolid",
        "antimicrobial_class": AntimicrobialClass.OXAZOLIDINONE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Reserve",
        "display_order": 95,
    },
    {
        "code": "SXT",
        "name": "Trimethoprim-sulfamethoxazole",
        "antimicrobial_class": AntimicrobialClass.FOLATE_INHIBITOR,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 100,
    },
    {
        "code": "NIT",
        "name": "Nitrofurantoin",
        "antimicrobial_class": AntimicrobialClass.NITROFURAN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 105,
    },
    {
        "code": "CHL",
        "name": "Chloramphenicol",
        "antimicrobial_class": AntimicrobialClass.PHENICOL,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 110,
    },
    {
        "code": "COL",
        "name": "Colistin",
        "antimicrobial_class": AntimicrobialClass.POLYMYXIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Reserve",
        "display_order": 115,
    },
    # Antifungals
    {
        "code": "FLU",
        "name": "Fluconazole",
        "antimicrobial_class": AntimicrobialClass.AZOLE,
        "target_kingdom": OrganismKingdom.FUNGI,
        "who_aware_category": None,
        "display_order": 200,
    },
    {
        "code": "VOR",
        "name": "Voriconazole",
        "antimicrobial_class": AntimicrobialClass.AZOLE,
        "target_kingdom": OrganismKingdom.FUNGI,
        "who_aware_category": None,
        "display_order": 201,
    },
    {
        "code": "ITR",
        "name": "Itraconazole",
        "antimicrobial_class": AntimicrobialClass.AZOLE,
        "target_kingdom": OrganismKingdom.FUNGI,
        "who_aware_category": None,
        "display_order": 202,
    },
    {
        "code": "CAS",
        "name": "Caspofungin",
        "antimicrobial_class": AntimicrobialClass.ECHINOCANDIN,
        "target_kingdom": OrganismKingdom.FUNGI,
        "who_aware_category": None,
        "display_order": 210,
    },
    {
        "code": "MIF",
        "name": "Micafungin",
        "antimicrobial_class": AntimicrobialClass.ECHINOCANDIN,
        "target_kingdom": OrganismKingdom.FUNGI,
        "who_aware_category": None,
        "display_order": 211,
    },
    {
        "code": "AMB",
        "name": "Amphotericin B",
        "antimicrobial_class": AntimicrobialClass.POLYENE,
        "target_kingdom": OrganismKingdom.FUNGI,
        "who_aware_category": None,
        "display_order": 220,
    },
    {
        "code": "FCY",
        "name": "Flucytosine",
        "antimicrobial_class": AntimicrobialClass.PYRIMIDINE_ANALOGUE,
        "target_kingdom": OrganismKingdom.FUNGI,
        "who_aware_category": None,
        "display_order": 230,
    },
    {
        "code": "AMX",
        "name": "Amoxicillin",
        "antimicrobial_class": AntimicrobialClass.PENICILLIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 13,
    },
    {
        "code": "CXM",
        "name": "Cefuroxime",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 29,
    },
    {
        "code": "CFM",
        "name": "Cefixime",
        "antimicrobial_class": AntimicrobialClass.CEPHALOSPORIN,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 36,
    },
    {
        "code": "AZM",
        "name": "Azithromycin",
        "antimicrobial_class": AntimicrobialClass.MACROLIDE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 71,
    },
    {
        "code": "NAL",
        "name": "Nalidixic acid",
        "antimicrobial_class": AntimicrobialClass.FLUOROQUINOLONE,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Watch",
        "display_order": 62,
    },
    {
        "code": "SMX",
        "name": "Sulfamethoxazole",
        "antimicrobial_class": AntimicrobialClass.FOLATE_INHIBITOR,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": "Access",
        "display_order": 101,
    },
    {
        "code": "NOV",
        "name": "Novobiocin",
        "antimicrobial_class": AntimicrobialClass.OTHER,
        "target_kingdom": OrganismKingdom.BACTERIA,
        "who_aware_category": None,
        "display_order": 120,
    },
]


SPECIMEN_TYPES: list[SpecimenSeed] = [
    {"code": "bl", "name": "Blood", "infection_site": "bloodstream", "is_sterile_site": True},
    {
        "code": "csf",
        "name": "Cerebrospinal fluid",
        "infection_site": "central nervous system",
        "is_sterile_site": True,
    },
    {"code": "ur", "name": "Urine", "infection_site": "urinary tract", "is_sterile_site": False},
    {
        "code": "sp",
        "name": "Sputum",
        "infection_site": "lower respiratory tract",
        "is_sterile_site": False,
    },
    {
        "code": "ta",
        "name": "Tracheal aspirate",
        "infection_site": "lower respiratory tract",
        "is_sterile_site": False,
    },
    {
        "code": "ws",
        "name": "Wound swab",
        "infection_site": "skin and soft tissue",
        "is_sterile_site": False,
    },
    {
        "code": "pu",
        "name": "Pus",
        "infection_site": "skin and soft tissue",
        "is_sterile_site": False,
    },
    {
        "code": "st",
        "name": "Stool",
        "infection_site": "gastrointestinal tract",
        "is_sterile_site": False,
    },
    {
        "code": "hv",
        "name": "High vaginal swab",
        "infection_site": "genital tract",
        "is_sterile_site": False,
    },
    {
        "code": "ef",
        "name": "Ear/eye fluid",
        "infection_site": "ear or eye",
        "is_sterile_site": False,
    },
    {
        "code": "pf",
        "name": "Sterile body fluid",
        "infection_site": "sterile body fluid",
        "is_sterile_site": True,
    },
    {"code": "ti", "name": "Tissue", "infection_site": "deep tissue", "is_sterile_site": True},
    {
        "code": "gf",
        "name": "Genital fluid / swab",
        "infection_site": "genital tract",
        "is_sterile_site": False,
    },
    {
        "code": "wd",
        "name": "Wound",
        "infection_site": "skin and soft tissue",
        "is_sterile_site": False,
    },
    {"code": "at", "name": "Aspirate", "infection_site": "deep tissue", "is_sterile_site": True},
    {
        "code": "gm",
        "name": "Genital male specimen",
        "infection_site": "genital tract",
        "is_sterile_site": False,
    },
    {"code": "sm", "name": "Semen", "infection_site": "genital tract", "is_sterile_site": False},
    {"code": "bo", "name": "Bone", "infection_site": "bone and joint", "is_sterile_site": True},
]
