/**
 * Persona dispatcher.
 * Selects the active persona module based on `config.persona`.
 *
 * To add a new persona:
 *   1. Create src/personas/<name>.ts exporting the same shape as raphael.ts.
 *   2. Register it in the `all` map below.
 *   3. Set PERSONA=<name> in .env.
 */

import { config } from "../config.js";
import * as quant from "./quant.js";
import * as raphael from "./raphael.js";
import * as spawner from "./spawner.js";

type Persona = typeof raphael;

const all = {
  quant,
  raphael,
  spawner,
} as const satisfies Record<string, Persona>;

const name = config.persona;
const selected = (all as Record<string, Persona>)[name];
if (!selected) {
  throw new Error(
    `Unknown persona "${name}". Available: ${Object.keys(all).join(", ")}`,
  );
}

export default selected;
