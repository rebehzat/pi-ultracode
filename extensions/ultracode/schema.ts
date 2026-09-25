/**
 * Minimal JSON Schema validator for structured agent output.
 *
 * Covers the subset workflow scripts use in practice: type, enum, const,
 * required, properties, additionalProperties, items, min/max(Length|Items),
 * minimum/maximum, anyOf/oneOf/allOf. Unknown keywords are ignored.
 */

export type JsonSchema = Record<string, any>;

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
	const actual = typeOf(value);
	if (type === "number") return actual === "number" || actual === "integer";
	return actual === type;
}

export function validate(schema: JsonSchema | boolean | undefined, value: unknown, path = "$"): string[] {
	if (schema === undefined || schema === true) return [];
	if (schema === false) return [`${path}: no value is allowed here`];
	const errors: string[] = [];

	if (schema.type !== undefined) {
		const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((t) => matchesType(value, t))) {
			return [`${path}: expected ${types.join(" | ")}, got ${typeOf(value)}`];
		}
	}
	if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
		errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
	}
	if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
		errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
	}

	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
		if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
		if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
	}

	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
		if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
		if (schema.items && typeof schema.items === "object") {
			value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
		}
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in obj)) errors.push(`${path}: missing required property "${key}"`);
		}
		const props: Record<string, JsonSchema> = schema.properties ?? {};
		for (const [key, child] of Object.entries(obj)) {
			if (key in props) errors.push(...validate(props[key], child, `${path}.${key}`));
			else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
			else if (typeof schema.additionalProperties === "object") {
				errors.push(...validate(schema.additionalProperties, child, `${path}.${key}`));
			}
		}
	}

	for (const sub of schema.allOf ?? []) errors.push(...validate(sub, value, path));
	const alternatives = schema.anyOf ?? schema.oneOf;
	if (alternatives && !alternatives.some((sub: JsonSchema) => validate(sub, value, path).length === 0)) {
		errors.push(`${path}: does not match any allowed alternative`);
	}
	return errors;
}

/** Find contradictions we can prove before spending tokens on an agent. */
export function findContradiction(schema: JsonSchema, path = "$"): string | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	if (schema.additionalProperties === false && Array.isArray(schema.required)) {
		const props = schema.properties ?? {};
		for (const key of schema.required) {
			if (!(key in props)) {
				return `${path}: "${key}" is required but additionalProperties: false rules it out (it is not listed in properties)`;
			}
		}
	}
	for (const [key, child] of Object.entries(schema.properties ?? {})) {
		const found = findContradiction(child as JsonSchema, `${path}.${key}`);
		if (found) return found;
	}
	if (schema.items && typeof schema.items === "object") return findContradiction(schema.items, `${path}[]`);
	return undefined;
}

/** Pull a JSON value out of an agent's final message (tolerates code fences and prose around it). */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const candidates: string[] = [];
	const trimmed = text.trim();
	candidates.push(trimmed);
	for (const m of trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
	const firstObj = trimmed.search(/[[{]/);
	if (firstObj >= 0) {
		const open = trimmed[firstObj]!;
		const close = open === "{" ? "}" : "]";
		const last = trimmed.lastIndexOf(close);
		if (last > firstObj) candidates.push(trimmed.slice(firstObj, last + 1));
	}
	for (const c of candidates) {
		try {
			return { ok: true, value: JSON.parse(c) };
		} catch {}
	}
	return { ok: false, error: "final message did not contain parseable JSON" };
}
