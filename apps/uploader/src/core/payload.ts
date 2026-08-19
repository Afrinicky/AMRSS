/**
 * Building and transmitting a batch.
 *
 * The uploader is offline up to the final step. Everything here — reading,
 * de-identifying, validating, compressing — happens on the facility's machine,
 * and only the last function touches the network.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  assertNoDirectIdentifiers,
  type DeidentifiedIsolate,
  deidentify,
  type DeidentificationOptions,
  type SourceIsolate,
  toIsoDate,
} from "./deidentify";

export const PAYLOAD_VERSION = "1.0";
export const UPLOADER_VERSION = "0.4.1";

export interface QcAttestationInput {
  periodStart: Date;
  periodEnd: Date;
  status: "satisfactory" | "unsatisfactory" | "not_submitted";
  correctiveAction?: string;
  notes?: string;
}

export interface BuildOptions extends DeidentificationOptions {
  whonetConfigVersion?: string;
  astBreakpointStandard?: string;
  qcAttestation?: QcAttestationInput;
  /** Records already accepted by the cloud, so incremental sync sends only what
   * is new. Held locally; the server checks independently. */
  alreadySent?: ReadonlySet<string>;
}

export interface BuiltBatch {
  /** What a facility user reviews before confirming. Contains no identifiers. */
  summary: {
    isolateCount: number;
    skippedAsAlreadySent: number;
    coverageStart: string;
    coverageEnd: string;
    organismCount: number;
    resultCount: number;
    qcStatus: string;
    compressedBytes: number;
  };
  checksum: string;
  body: Buffer;
  /** Source record hashes in this batch, recorded locally once it is accepted. */
  recordHashes: string[];
}

export function buildBatch(
  facilityCode: string,
  sources: SourceIsolate[],
  options: BuildOptions,
): BuiltBatch {
  const isolates: DeidentifiedIsolate[] = [];
  let skipped = 0;

  for (const source of sources) {
    const record = deidentify(source, options);
    if (options.alreadySent?.has(record.source_record_hash)) {
      skipped += 1;
      continue;
    }
    isolates.push(record);
  }

  if (isolates.length === 0) {
    throw new Error(
      "Nothing new to send: every isolate in the selected period has already been " +
        "accepted. This is normal if no new results have been entered since the last upload.",
    );
  }

  const dates = isolates.map((isolate) => isolate.specimen_date).sort();
  const document = {
    payload_version: PAYLOAD_VERSION,
    uploader_version: UPLOADER_VERSION,
    facility_code: facilityCode,
    whonet_config_version: options.whonetConfigVersion ?? null,
    ast_breakpoint_standard: options.astBreakpointStandard ?? null,
    generated_at: new Date().toISOString(),
    coverage_start: dates[0]!,
    coverage_end: dates[dates.length - 1]!,
    isolates,
    qc_attestation: options.qcAttestation
      ? {
          period_start: toIsoDate(options.qcAttestation.periodStart),
          period_end: toIsoDate(options.qcAttestation.periodEnd),
          status: options.qcAttestation.status,
          corrective_action: options.qcAttestation.correctiveAction ?? null,
          notes: options.qcAttestation.notes ?? null,
        }
      : null,
  };

  // Last line of defence before anything is serialised for transmission. The
  // allow-list construction in deidentify() should make this unreachable; if it
  // ever fires, the upload stops at the facility rather than succeeding quietly.
  assertNoDirectIdentifiers(document);

  const body = gzipSync(Buffer.from(JSON.stringify(document), "utf8"), { level: 9 });
  const checksum = createHash("sha256").update(body).digest("hex");

  return {
    summary: {
      isolateCount: isolates.length,
      skippedAsAlreadySent: skipped,
      coverageStart: document.coverage_start,
      coverageEnd: document.coverage_end,
      organismCount: new Set(isolates.map((isolate) => isolate.organism_code)).size,
      resultCount: isolates.reduce((total, isolate) => total + isolate.ast_results.length, 0),
      qcStatus: options.qcAttestation?.status ?? "not submitted with this batch",
      compressedBytes: body.byteLength,
    },
    checksum,
    body,
    recordHashes: isolates.map((isolate) => isolate.source_record_hash),
  };
}

export interface TransmitResult {
  ok: boolean;
  status: number;
  batchId?: string;
  batchStatus?: string;
  message: string;
  findings: Array<{ code: string; severity: string; message: string }>;
}

/** The only function in the uploader that touches the network. */
export async function transmit(
  apiUrl: string,
  accessToken: string,
  batch: BuiltBatch,
): Promise<TransmitResult> {
  const response = await fetch(`${apiUrl}/api/v1/ingestion/batches`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-amrss-checksum": batch.checksum,
      authorization: `Bearer ${accessToken}`,
    },
    body: new Uint8Array(batch.body),
  });

  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        typeof parsed.detail === "string"
          ? parsed.detail
          : `Upload failed with status ${response.status}.`,
      findings: [],
    };
  }

  return {
    ok: true,
    status: response.status,
    batchId: parsed.batch_id as string | undefined,
    batchStatus: parsed.status as string | undefined,
    message: (parsed.message as string) ?? "Upload complete.",
    findings: (parsed.findings ?? []) as TransmitResult["findings"],
  };
}
