/**
 * The WHONET code dictionary the uploader reads a laboratory's file with.
 *
 * Every entry here is a copy of the platform's canonical dictionary
 * (`apps/api/amrss/seed/dictionary_data.py`), deliberately so. The uploader must
 * be able to name an organism, a specimen and an agent with no network — a
 * laboratory grading its own data at the bench cannot wait for a server — and
 * the codes it shows locally have to be the same codes the platform stores, or
 * the two halves would disagree about what the facility submitted.
 *
 * The copy is not authoritative. Anything the local dictionary cannot name is
 * surfaced as a mapping gap for the facility to resolve before upload, never
 * guessed, and the server re-resolves every code on ingest against its own
 * dictionary. A stale copy therefore produces a visible question, not corrupt
 * data.
 */

export type Kingdom = "bacteria" | "fungi";

export interface OrganismEntry {
  code: string;
  name: string;
  kingdom: Kingdom;
  genus: string | null;
  family: string | null;
  gramStain: string | null;
  isEnterobacterales: boolean;
  specialImportance: boolean;
  /** Explicit CLSI organism groups, most specific first. Where absent,
   * GENUS_CLSI_GROUPS supplies them. */
  clsiGroups?: string[];
}

export interface AntibioticEntry {
  code: string;
  name: string;
  antimicrobialClass: string;
  targetKingdom: Kingdom;
  whoAware: string | null;
  displayOrder: number;
  /** The agent's spelling in a CLSI table, where it differs from the code. */
  clsiAgentCode?: string;
}

export interface SpecimenEntry {
  code: string;
  name: string;
  infectionSite: string;
  sterileSite: boolean;
}

export const ORGANISMS: OrganismEntry[] = [
  { code: "eco", name: "Escherichia coli", kingdom: "bacteria", genus: "Escherichia", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: true },
  { code: "kpn", name: "Klebsiella pneumoniae", kingdom: "bacteria", genus: "Klebsiella", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: true },
  { code: "kox", name: "Klebsiella oxytoca", kingdom: "bacteria", genus: "Klebsiella", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "ent", name: "Enterobacter cloacae complex", kingdom: "bacteria", genus: "Enterobacter", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "pmi", name: "Proteus mirabilis", kingdom: "bacteria", genus: "Proteus", family: "Morganellaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "sal", name: "Salmonella species", kingdom: "bacteria", genus: "Salmonella", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: true },
  { code: "shi", name: "Shigella species", kingdom: "bacteria", genus: "Shigella", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: true },
  { code: "pae", name: "Pseudomonas aeruginosa", kingdom: "bacteria", genus: "Pseudomonas", family: "Pseudomonadaceae", gramStain: "negative", isEnterobacterales: false, specialImportance: true },
  { code: "aba", name: "Acinetobacter baumannii complex", kingdom: "bacteria", genus: "Acinetobacter", family: "Moraxellaceae", gramStain: "negative", isEnterobacterales: false, specialImportance: true },
  { code: "sau", name: "Staphylococcus aureus", kingdom: "bacteria", genus: "Staphylococcus", family: "Staphylococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: true },
  { code: "cns", name: "Coagulase-negative Staphylococcus", kingdom: "bacteria", genus: "Staphylococcus", family: "Staphylococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: false },
  { code: "spn", name: "Streptococcus pneumoniae", kingdom: "bacteria", genus: "Streptococcus", family: "Streptococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: true, clsiGroups: ["Streptococcus pneumoniae"] },
  { code: "efa", name: "Enterococcus faecalis", kingdom: "bacteria", genus: "Enterococcus", family: "Enterococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: true },
  { code: "efm", name: "Enterococcus faecium", kingdom: "bacteria", genus: "Enterococcus", family: "Enterococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: true },
  { code: "cal", name: "Candida albicans", kingdom: "fungi", genus: "Candida", family: "Debaryomycetaceae", gramStain: null, isEnterobacterales: false, specialImportance: false },
  { code: "cgl", name: "Nakaseomyces glabratus (Candida glabrata)", kingdom: "fungi", genus: "Nakaseomyces", family: "Saccharomycetaceae", gramStain: null, isEnterobacterales: false, specialImportance: true },
  { code: "ctr", name: "Candida tropicalis", kingdom: "fungi", genus: "Candida", family: "Debaryomycetaceae", gramStain: null, isEnterobacterales: false, specialImportance: false },
  { code: "cpa", name: "Candida parapsilosis", kingdom: "fungi", genus: "Candida", family: "Debaryomycetaceae", gramStain: null, isEnterobacterales: false, specialImportance: false },
  { code: "cau", name: "Candidozyma auris (Candida auris)", kingdom: "fungi", genus: "Candidozyma", family: "Metschnikowiaceae", gramStain: null, isEnterobacterales: false, specialImportance: true },
  { code: "cne", name: "Cryptococcus neoformans", kingdom: "fungi", genus: "Cryptococcus", family: "Cryptococcaceae", gramStain: null, isEnterobacterales: false, specialImportance: true },
  { code: "kl-", name: "Klebsiella species", kingdom: "bacteria", genus: "Klebsiella", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: true },
  { code: "ci-", name: "Citrobacter species", kingdom: "bacteria", genus: "Citrobacter", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "en-", name: "Enterobacter species", kingdom: "bacteria", genus: "Enterobacter", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "ps-", name: "Pseudomonas species", kingdom: "bacteria", genus: "Pseudomonas", family: "Pseudomonadaceae", gramStain: "negative", isEnterobacterales: false, specialImportance: true, clsiGroups: ["Other Non-Enterobacterales"] },
  { code: "pr-", name: "Proteus species", kingdom: "bacteria", genus: "Proteus", family: "Morganellaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "ne-", name: "Neisseria species", kingdom: "bacteria", genus: "Neisseria", family: "Neisseriaceae", gramStain: "negative", isEnterobacterales: false, specialImportance: false },
  { code: "pvu", name: "Proteus vulgaris", kingdom: "bacteria", genus: "Proteus", family: "Morganellaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "mmo", name: "Morganella morganii", kingdom: "bacteria", genus: "Morganella", family: "Morganellaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "sep", name: "Staphylococcus epidermidis", kingdom: "bacteria", genus: "Staphylococcus", family: "Staphylococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: false },
  { code: "bca", name: "Burkholderia cepacia complex", kingdom: "bacteria", genus: "Burkholderia", family: "Burkholderiaceae", gramStain: "negative", isEnterobacterales: false, specialImportance: true },
  { code: "can", name: "Candida species", kingdom: "fungi", genus: "Candida", family: "Debaryomycetaceae", gramStain: null, isEnterobacterales: false, specialImportance: false },
  { code: "sap", name: "Staphylococcus saprophyticus", kingdom: "bacteria", genus: "Staphylococcus", family: "Staphylococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: false },
  { code: "sta", name: "Staphylococcus species", kingdom: "bacteria", genus: "Staphylococcus", family: "Staphylococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: false },
  { code: "svi", name: "Streptococcus, viridans group", kingdom: "bacteria", genus: "Streptococcus", family: "Streptococcaceae", gramStain: "positive", isEnterobacterales: false, specialImportance: false },
  { code: "cfr", name: "Citrobacter freundii", kingdom: "bacteria", genus: "Citrobacter", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "cdi", name: "Citrobacter koseri (diversus)", kingdom: "bacteria", genus: "Citrobacter", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "ecl", name: "Enterobacter cloacae", kingdom: "bacteria", genus: "Enterobacter", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: true },
  { code: "eae", name: "Klebsiella aerogenes (Enterobacter aerogenes)", kingdom: "bacteria", genus: "Klebsiella", family: "Enterobacteriaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "sma", name: "Serratia marcescens", kingdom: "bacteria", genus: "Serratia", family: "Yersiniaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "pre", name: "Providencia rettgeri", kingdom: "bacteria", genus: "Providencia", family: "Morganellaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "yer", name: "Yersinia enterocolitica", kingdom: "bacteria", genus: "Yersinia", family: "Yersiniaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "yep", name: "Yersinia pestis", kingdom: "bacteria", genus: "Yersinia", family: "Yersiniaceae", gramStain: "negative", isEnterobacterales: true, specialImportance: false },
  { code: "gnr", name: "Gram-negative rod (unidentified)", kingdom: "bacteria", genus: null, family: null, gramStain: "negative", isEnterobacterales: false, specialImportance: false },
];

export const ANTIBIOTICS: AntibioticEntry[] = [
  { code: "AMP", name: "Ampicillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 10 },
  { code: "PEN", name: "Benzylpenicillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 11 },
  { code: "OXA", name: "Oxacillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 12 },
  { code: "AMC", name: "Amoxicillin-clavulanate", antimicrobialClass: "beta_lactam_inhibitor", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 20 },
  { code: "TZP", name: "Piperacillin-tazobactam", antimicrobialClass: "beta_lactam_inhibitor", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 21 },
  { code: "CZO", name: "Cefazolin", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 30 },
  { code: "FOX", name: "Cefoxitin", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 31 },
  { code: "CRO", name: "Ceftriaxone", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 32 },
  { code: "CTX", name: "Cefotaxime", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 33 },
  { code: "CAZ", name: "Ceftazidime", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 34 },
  { code: "FEP", name: "Cefepime", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 35 },
  { code: "ETP", name: "Ertapenem", antimicrobialClass: "carbapenem", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 40 },
  { code: "IPM", name: "Imipenem", antimicrobialClass: "carbapenem", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 41 },
  { code: "MEM", name: "Meropenem", antimicrobialClass: "carbapenem", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 42 },
  { code: "GEN", name: "Gentamicin", antimicrobialClass: "aminoglycoside", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 50 },
  { code: "AMK", name: "Amikacin", antimicrobialClass: "aminoglycoside", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 51 },
  { code: "CIP", name: "Ciprofloxacin", antimicrobialClass: "fluoroquinolone", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 60 },
  { code: "LVX", name: "Levofloxacin", antimicrobialClass: "fluoroquinolone", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 61 },
  { code: "ERY", name: "Erythromycin", antimicrobialClass: "macrolide", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 70 },
  { code: "CLI", name: "Clindamycin", antimicrobialClass: "lincosamide", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 75 },
  { code: "TCY", name: "Tetracycline", antimicrobialClass: "tetracycline", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 80 },
  { code: "VAN", name: "Vancomycin", antimicrobialClass: "glycopeptide", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 90 },
  { code: "LNZ", name: "Linezolid", antimicrobialClass: "oxazolidinone", targetKingdom: "bacteria", whoAware: "Reserve", displayOrder: 95 },
  { code: "SXT", name: "Trimethoprim-sulfamethoxazole", antimicrobialClass: "folate_inhibitor", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 100 },
  { code: "NIT", name: "Nitrofurantoin", antimicrobialClass: "nitrofuran", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 105 },
  { code: "CHL", name: "Chloramphenicol", antimicrobialClass: "phenicol", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 110 },
  { code: "COL", name: "Colistin", antimicrobialClass: "polymyxin", targetKingdom: "bacteria", whoAware: "Reserve", displayOrder: 115 },
  { code: "FLU", name: "Fluconazole", antimicrobialClass: "azole", targetKingdom: "fungi", whoAware: null, displayOrder: 200 },
  { code: "VOR", name: "Voriconazole", antimicrobialClass: "azole", targetKingdom: "fungi", whoAware: null, displayOrder: 201 },
  { code: "ITR", name: "Itraconazole", antimicrobialClass: "azole", targetKingdom: "fungi", whoAware: null, displayOrder: 202 },
  { code: "CAS", name: "Caspofungin", antimicrobialClass: "echinocandin", targetKingdom: "fungi", whoAware: null, displayOrder: 210 },
  { code: "MIF", name: "Micafungin", antimicrobialClass: "echinocandin", targetKingdom: "fungi", whoAware: null, displayOrder: 211 },
  { code: "AMB", name: "Amphotericin B", antimicrobialClass: "polyene", targetKingdom: "fungi", whoAware: null, displayOrder: 220 },
  { code: "FCY", name: "Flucytosine", antimicrobialClass: "pyrimidine_analogue", targetKingdom: "fungi", whoAware: null, displayOrder: 230 },
  { code: "AMX", name: "Amoxicillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 13 },
  { code: "CXM", name: "Cefuroxime", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 29 },
  { code: "CFM", name: "Cefixime", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 36 },
  { code: "AZM", name: "Azithromycin", antimicrobialClass: "macrolide", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 71 },
  { code: "NAL", name: "Nalidixic acid", antimicrobialClass: "fluoroquinolone", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 62 },
  { code: "SMX", name: "Sulfamethoxazole", antimicrobialClass: "folate_inhibitor", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 101 },
  { code: "NOV", name: "Novobiocin", antimicrobialClass: "other", targetKingdom: "bacteria", whoAware: null, displayOrder: 120 },
  { code: "TIC", name: "Ticarcillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 13 },
  { code: "PIP", name: "Piperacillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 14 },
  { code: "MEZ", name: "Mezlocillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 15 },
  { code: "CRB", name: "Carbenicillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 16 },
  { code: "CLO", name: "Cloxacillin", antimicrobialClass: "penicillin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 17 },
  { code: "SAM", name: "Ampicillin-sulbactam", antimicrobialClass: "beta_lactam_inhibitor", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 22 },
  { code: "TCC", name: "Ticarcillin-clavulanate", antimicrobialClass: "beta_lactam_inhibitor", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 23 },
  { code: "LEX", name: "Cephalexin", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 31 },
  { code: "CEP", name: "Cephalothin", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 32 },
  { code: "CZX", name: "Ceftizoxime", antimicrobialClass: "cephalosporin", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 39 },
  { code: "ATM", name: "Aztreonam", antimicrobialClass: "monobactam", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 45 },
  { code: "TOB", name: "Tobramycin", antimicrobialClass: "aminoglycoside", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 61 },
  { code: "NOR", name: "Norfloxacin", antimicrobialClass: "fluoroquinolone", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 71 },
  { code: "OFX", name: "Ofloxacin", antimicrobialClass: "fluoroquinolone", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 72 },
  { code: "DOX", name: "Doxycycline", antimicrobialClass: "tetracycline", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 81 },
  { code: "MNO", name: "Minocycline", antimicrobialClass: "tetracycline", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 82 },
  { code: "RXT", name: "Roxithromycin", antimicrobialClass: "macrolide", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 91 },
  { code: "LIN", name: "Lincomycin", antimicrobialClass: "lincosamide", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 96 },
  { code: "SSS", name: "Sulfonamides", antimicrobialClass: "folate_inhibitor", targetKingdom: "bacteria", whoAware: "Access", displayOrder: 102 },
  { code: "TEC", name: "Teicoplanin", antimicrobialClass: "glycopeptide", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 111 },
  { code: "RIF", name: "Rifampicin", antimicrobialClass: "other", targetKingdom: "bacteria", whoAware: "Watch", displayOrder: 121 },
];

export const SPECIMEN_TYPES: SpecimenEntry[] = [
  { code: "bl", name: "Blood", infectionSite: "bloodstream", sterileSite: true },
  { code: "csf", name: "Cerebrospinal fluid", infectionSite: "central nervous system", sterileSite: true },
  { code: "ur", name: "Urine", infectionSite: "urinary tract", sterileSite: false },
  { code: "sp", name: "Sputum", infectionSite: "lower respiratory tract", sterileSite: false },
  { code: "ta", name: "Tracheal aspirate", infectionSite: "lower respiratory tract", sterileSite: false },
  { code: "ws", name: "Wound swab", infectionSite: "skin and soft tissue", sterileSite: false },
  { code: "pu", name: "Pus", infectionSite: "skin and soft tissue", sterileSite: false },
  { code: "st", name: "Stool", infectionSite: "gastrointestinal tract", sterileSite: false },
  { code: "hv", name: "High vaginal swab", infectionSite: "genital tract", sterileSite: false },
  { code: "ef", name: "Ear/eye fluid", infectionSite: "ear or eye", sterileSite: false },
  { code: "pf", name: "Sterile body fluid", infectionSite: "sterile body fluid", sterileSite: true },
  { code: "ti", name: "Tissue", infectionSite: "deep tissue", sterileSite: true },
  { code: "gf", name: "Genital fluid / swab", infectionSite: "genital tract", sterileSite: false },
  { code: "wd", name: "Wound", infectionSite: "skin and soft tissue", sterileSite: false },
  { code: "at", name: "Aspirate", infectionSite: "deep tissue", sterileSite: true },
  { code: "gm", name: "Genital male specimen", infectionSite: "genital tract", sterileSite: false },
  { code: "sm", name: "Semen", infectionSite: "genital tract", sterileSite: false },
  { code: "bo", name: "Bone", infectionSite: "bone and joint", sterileSite: true },
  { code: "va", name: "Vaginal swab", infectionSite: "genital tract", sterileSite: false },
  { code: "ue", name: "Urethral swab", infectionSite: "genital tract", sterileSite: false },
  { code: "ea", name: "Ear", infectionSite: "ear", sterileSite: false },
  { code: "th", name: "Throat swab", infectionSite: "upper respiratory tract", sterileSite: false },
  { code: "br", name: "Bronchial aspirate", infectionSite: "lower respiratory tract", sterileSite: false },
  { code: "sb", name: "Sputum (bronchial)", infectionSite: "lower respiratory tract", sterileSite: false },
  { code: "ps", name: "Pus", infectionSite: "skin and soft tissue", sterileSite: false },
  { code: "sk", name: "Skin", infectionSite: "skin and soft tissue", sterileSite: false },
  { code: "sw", name: "Swab (unspecified)", infectionSite: "skin and soft tissue", sterileSite: false },
  { code: "sf", name: "Body fluid", infectionSite: "other", sterileSite: false },
  { code: "la", name: "Other specimen", infectionSite: "other", sterileSite: false },
  { code: "h", name: "Other specimen", infectionSite: "other", sterileSite: false },
];

export const GENUS_CLSI_GROUPS: Record<string, string[]> = {
  "Staphylococcus": ["Staphylococcus spp."],
  "Enterococcus": ["Enterococcus spp."],
  "Streptococcus": ["Streptococcus spp."],
  "Salmonella": ["Salmonella and Shigella spp."],
  "Shigella": ["Salmonella and Shigella spp."],
  "Pseudomonas": ["Pseudomonas aeruginosa"],
  "Acinetobacter": ["Acinetobacter spp."],
  "Haemophilus": ["Haemophilus influenzae and Haemophilus parainfluenzae"],
  "Neisseria": ["Neisseria spp."],
  "Stenotrophomonas": ["Stenotrophomonas maltophilia"],
  "Burkholderia": ["Burkholderia cepacia complex", "Other Non-Enterobacterales"],
  "Campylobacter": ["Campylobacter jejuni/coli"],
  "Vibrio": ["Vibrio spp."],
  "Candida": ["Candida spp."],
  "Cryptococcus": ["Cryptococcus spp."],
  "Aspergillus": ["Aspergillus spp."],
};

/**
 * WHONET codes whose canonical entry exists under a different code.
 *
 * Kept in step with `apps/api/amrss/ingestion/whonet_aliases.py`. Recording the
 * same organism twice under two codes would split its counts, so a WHONET code
 * that names something the dictionary already holds is aliased rather than
 * added. A code that names something genuinely absent is a dictionary gap and
 * belongs in the mapping queue, not here.
 */
export const ORGANISM_ALIASES: Record<string, string> = {
  // WHONET's "Staphylococcus, coagulase negative".
  scn: "cns",
};

export const SPECIMEN_ALIASES: Record<string, string> = {
  // Free-text spellings seen in real exports where the laboratory typed the
  // name instead of picking the code.
  urine: "ur",
  blood: "bl",
  stool: "st",
  sputum: "sp",
  wound: "wd",
  // A biopsy is tissue; both are the same site to an antibiogram.
  bx: "ti",
  biopsy: "ti",
};

export const ANTIBIOTIC_ALIASES: Record<string, string> = {
  // WHONET writes cefazolin CFZ in some configurations; the dictionary holds it
  // under the CLSI spelling.
  CFZ: "CZO",
  // Amoxicillin/clavulanate is AUG in older WHONET configurations.
  AUG: "AMC",
  // Trimethoprim/sulfamethoxazole appears as both.
  TMS: "SXT",
  COT: "SXT",
};

/**
 * Culture results that name no organism.
 *
 * Two distinct laboratory outcomes, both excluded from surveillance:
 *
 * - **No growth** (`xxx`) — nothing grew.
 * - **No significant growth** (`xsg`) — something grew and the laboratory judged
 *   it flora or contamination.
 *
 * Across the two validation exports these accounted for 102 of 183 and 16 of 268
 * rows. Admitting them would invent organisms called "xxx" and "xsg", inflate
 * every workload count, and place meaningless rows in the antibiogram. They are
 * excluded from the batch, not deleted from the laboratory's own record: a
 * negative rate is real information about testing, just not about resistance.
 */
export const NO_ORGANISM_CODES = new Set([
  "xxx",
  "xsg",
  "nog",
  "nsg",
  "none",
  "no growth",
  "no significant growth",
  "nogrowth",
  "-",
  // Normal / mixed flora: growth that named no pathogen.
  "nor",
  "naf",
  "mix",
  "mixed",
  "normal flora",
  "mixed flora",
]);

export function isNoOrganism(organismCode: string | null | undefined): boolean {
  if (!organismCode) return true;
  return NO_ORGANISM_CODES.has(organismCode.trim().toLowerCase());
}

const ORGANISM_INDEX = new Map(ORGANISMS.map((entry) => [entry.code, entry]));
const ANTIBIOTIC_INDEX = new Map(ANTIBIOTICS.map((entry) => [entry.code, entry]));
const SPECIMEN_INDEX = new Map(SPECIMEN_TYPES.map((entry) => [entry.code, entry]));

/** The canonical code a WHONET organism code resolves to, aliases applied. */
export function canonicalOrganismCode(code: string): string {
  const token = code.trim().toLowerCase();
  return ORGANISM_ALIASES[token] ?? token;
}

export function canonicalSpecimenCode(code: string): string {
  const token = code.trim().toLowerCase();
  return SPECIMEN_ALIASES[token] ?? token;
}

export function canonicalAntibioticCode(code: string): string {
  const token = code.trim().toUpperCase();
  return ANTIBIOTIC_ALIASES[token] ?? token;
}

export function lookupOrganism(code: string): OrganismEntry | null {
  return ORGANISM_INDEX.get(canonicalOrganismCode(code)) ?? null;
}

export function lookupAntibiotic(code: string): AntibioticEntry | null {
  return ANTIBIOTIC_INDEX.get(canonicalAntibioticCode(code)) ?? null;
}

export function lookupSpecimen(code: string): SpecimenEntry | null {
  return SPECIMEN_INDEX.get(canonicalSpecimenCode(code)) ?? null;
}

/** A display label that degrades to the raw code rather than to "unknown".
 * A laboratory reading its own grid needs to see what it typed. */
export function organismLabel(code: string | null): string {
  if (!code) return "—";
  return lookupOrganism(code)?.name ?? code;
}

export function antibioticLabel(code: string | null): string {
  if (!code) return "—";
  return lookupAntibiotic(code)?.name ?? code;
}

export function specimenLabel(code: string | null): string {
  if (!code) return "—";
  return lookupSpecimen(code)?.name ?? code;
}

export function infectionSite(code: string | null): string {
  if (!code) return "unspecified";
  return lookupSpecimen(code)?.infectionSite ?? "unspecified";
}

/**
 * CLSI organism groups to try for an isolate, most specific first.
 *
 * Interpretation picks the first group the loaded table covers. Ordering
 * species before genus before family is what makes a species-specific criterion
 * win over the general one, which is how M100 itself is organised.
 */
export function clsiGroupsFor(organismCode: string): string[] {
  const organism = lookupOrganism(organismCode);
  if (!organism) return [];

  const groups: string[] = [organism.name];
  for (const group of organism.clsiGroups ?? []) groups.push(group);
  if (organism.genus) {
    for (const group of GENUS_CLSI_GROUPS[organism.genus] ?? []) groups.push(group);
    groups.push(`${organism.genus} spp.`);
  }
  if (organism.isEnterobacterales) groups.push("Enterobacterales", "Enterobacteriaceae");
  else if (organism.kingdom === "bacteria" && organism.gramStain === "negative") {
    groups.push("Other Non-Enterobacterales");
  }
  if (organism.kingdom === "fungi") groups.push("Fungi");

  return [...new Set(groups)];
}

/** WHONET's ORG_TYPE column, as a label for the grid. */
export const ORGANISM_TYPE_LABELS: Record<string, string> = {
  "+": "Gram-positive",
  "-": "Gram-negative",
  f: "Fungus / yeast",
  o: "Other",
  a: "Anaerobe",
  m: "Mycobacterium",
};

/** WHONET's SPEC_REAS column. */
export const SPECIMEN_REASON_LABELS: Record<string, string> = {
  d: "Diagnostic",
  s: "Surveillance / screening",
  f: "Follow-up",
  l: "Laboratory / other",
};

/** WHONET's WARD_TYPE column, mapped to the care setting surveillance uses.
 * Both files validated against use a different vocabulary here — "out"/"in" in
 * one, "Out"/"In" in the other, with "lab", "inx", "eme", "icu" and "dxc"
 * alongside — so the match is case-insensitive and covers what those exports
 * actually contain rather than one site's conventions. */
export const CARE_SETTING_TOKENS: Record<string, "IPD" | "OPD"> = {
  i: "IPD",
  in: "IPD",
  inx: "IPD",
  ip: "IPD",
  ipd: "IPD",
  inpatient: "IPD",
  admitted: "IPD",
  icu: "IPD",
  eme: "IPD",
  emergency: "IPD",
  w: "IPD",
  o: "OPD",
  out: "OPD",
  op: "OPD",
  opd: "OPD",
  outpatient: "OPD",
  ambulatory: "OPD",
  dxc: "OPD",
  clinic: "OPD",
};

export function careSettingOf(value: string | null | undefined): "IPD" | "OPD" | "unknown" {
  const token = (value ?? "").trim().toLowerCase();
  if (token === "") return "unknown";
  return CARE_SETTING_TOKENS[token] ?? "unknown";
}
