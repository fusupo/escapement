import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { FactoryError } from "./util.ts";
import type { Tier } from "./tiers.ts";

/**
 * The factory's published JSON Schemas (schemas/factory/*.schema.json at the
 * plugin root). Code validates against these exact files, so what hosts
 * read and what the runner enforces can't drift.
 */
export const SCHEMA_NAMES = ["contract", "report", "verdict", "readiness", "critique"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "factory");

export function schemaPath(name: SchemaName): string {
  return resolve(SCHEMA_DIR, `${name}.schema.json`);
}

export function isSchemaName(name: string): name is SchemaName {
  return (SCHEMA_NAMES as readonly string[]).includes(name);
}

let ajv: Ajv2020 | null = null;
const compiled = new Map<SchemaName, ValidateFunction>();

function validator(name: SchemaName): ValidateFunction {
  let fn = compiled.get(name);
  if (!fn) {
    // strictRequired would reject the per-type `required` lists in if/then branches.
    ajv ??= new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    fn = ajv.compile(JSON.parse(readFileSync(schemaPath(name), "utf-8")));
    compiled.set(name, fn);
  }
  return fn;
}

/** Keys a contract might use to set its own checks; they get a pointed error. */
const COMMAND_KEYS = new Set(["commands", "required-checks", "required_checks", "static", "verify", "setup", "narrow_verify"]);

function describe(err: ErrorObject): string | null {
  const at = err.instancePath || "(top level)";
  const p = err.params as Record<string, unknown>;
  // Wrapper errors whose detail is reported by another error.
  if (err.keyword === "if") return null;
  if ((err as { propertyName?: string }).propertyName !== undefined) return null;
  if (err.schemaPath.includes("/oneOf/")) return null;

  switch (err.keyword) {
    case "required":
      return `${at}: missing "${p.missingProperty}"`;
    case "additionalProperties": {
      const name = String(p.additionalProperty);
      const hint =
        err.instancePath === "" && COMMAND_KEYS.has(name)
          ? " (contracts name no commands; every check comes from project settings)"
          : "";
      return `${at}: unexpected property "${name}"${hint}`;
    }
    case "propertyNames":
      return `${at}: property "${p.propertyName}" is not allowed here`;
    case "enum":
      return `${at}: must be one of ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "const":
      return `${at}: must be ${JSON.stringify(p.allowedValue)}`;
    case "oneOf":
      return /^\/evidence\/\d+$/.test(err.instancePath)
        ? `${at}: needs exactly one of "supports_criterion" or "procedure_adequate"`
        : `${at}: must match exactly one allowed form`;
    default:
      return `${at}: ${err.message ?? err.keyword}`;
  }
}

/** Validate `data` against a published schema. Returns readable errors; empty means valid. */
export function schemaErrors(name: SchemaName, data: unknown): string[] {
  const fn = validator(name);
  if (fn(data)) return [];
  const out: string[] = [];
  for (const err of fn.errors ?? []) {
    const text = describe(err);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

export type Evidence =
  | { id: string; type: "test"; kind: EvidenceKind; selector: string; cwd?: string; timeout_s?: number }
  | {
      id: string;
      type: "command";
      kind: EvidenceKind;
      run: string;
      cwd?: string;
      timeout_s?: number;
      expect: { exit_code: number; stdout_matches?: string; stdout_not_matches?: string };
    }
  | { id: string; type: "manual"; kind: EvidenceKind; instructions: string };

export type EvidenceKind = "new_behavior" | "regression";

export type Contract = {
  version: 1;
  run_id: string;
  issue?: number | null;
  manifest_id?: string | null;
  risk_tier_proposed: Tier;
  risk_reasons?: string[];
  criteria: { id: string; text: string; evidence: Evidence[] }[];
  predicted_files?: string[];
};

/**
 * Every problem with a contract: schema errors, then the rules a schema
 * can't express (unique criterion IDs, unique evidence IDs across the
 * contract, valid regular expressions).
 */
export function contractErrors(data: unknown): string[] {
  const errors = schemaErrors("contract", data);
  if (errors.length > 0) return errors;

  const contract = data as Contract;
  const criteria = new Set<string>();
  const evidence = new Set<string>();
  contract.criteria.forEach((c, i) => {
    if (criteria.has(c.id)) errors.push(`/criteria/${i}/id: duplicate criterion ID "${c.id}"`);
    criteria.add(c.id);
    c.evidence.forEach((e, j) => {
      const at = `/criteria/${i}/evidence/${j}`;
      if (evidence.has(e.id)) errors.push(`${at}/id: duplicate evidence ID "${e.id}"`);
      evidence.add(e.id);
      if (e.type === "command") {
        for (const key of ["stdout_matches", "stdout_not_matches"] as const) {
          const pattern = e.expect[key];
          if (pattern === undefined) continue;
          try {
            new RegExp(pattern);
          } catch {
            errors.push(`${at}/expect/${key}: not a valid regular expression`);
          }
        }
      }
    });
  });
  return errors;
}

/** Parse contract JSON text, throwing `bad_contract` with every problem listed. */
export function parseContract(text: string, source = "contract"): Contract {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new FactoryError("bad_contract", `${source} is not valid JSON: ${(err as Error).message}`);
  }
  const errors = contractErrors(data);
  if (errors.length > 0) {
    throw new FactoryError("bad_contract", `${source} is not a valid contract:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  }
  return data as Contract;
}
