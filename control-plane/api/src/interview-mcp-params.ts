/**
 * Tool parameters shared by the interview MCP server's two submit tools.
 *
 * Their own module because `interview-mcp.ts` is an entrypoint: importing it
 * exits when INTERVIEW_MCP_KEY is unset and starts listening otherwise, so a
 * test cannot reach the schemas there. Keeping them side-effect-free is what
 * makes the coverage assertion in interview-mcp-tools.test.ts possible.
 */
import { z } from "zod";

/**
 * `data` as the two submit tools accept it.
 *
 * A structured question wants a real array or object, and the prompts say so
 * — but a model that has just written JSON into its reasoning hands it over
 * as a *string* often enough that the tool description already carries a
 * "never as a string" warning. A warning is not a mechanism: the strict union
 * rejected the string at the MCP boundary, so the organizer's answer failed to
 * submit with nothing recorded and no way for the agent to tell what was
 * wrong. Parsing it here is the tolerant end of "be liberal in what you
 * accept" — the value still has to satisfy validateAnswer's dataShape check
 * one hop later, so nothing is loosened about what actually gets stored.
 *
 * Anything that is not a JSON string encoding an array or object is passed
 * through untouched, to be refused by the schema below it as before.
 */
export const dataParam = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}, z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional());

/**
 * The parameters an answer can be carried in, shared by `submit_answer` and
 * `submit_answer_for_chat`.
 *
 * They are one definition because they drift otherwise, and did: `optionIds`
 * was added for the chat-addressed tool and never backported to the
 * token-carrying one, which left every `multi_choice` question — `dietary` is
 * the one an organizer actually reaches — impossible to answer. Every
 * parameter that tool exposed was refused OPTIONS_REQUIRED by validateAnswer,
 * because the only parameter that satisfies a multi_choice question was the
 * one missing from the schema. `interview-mcp-tools.test.ts` now asserts
 * coverage over every question type rather than trusting this to be noticed.
 */
export const answerParams = {
  questionId: z.string().describe("Question id, e.g. \"destination\" or \"travelers\" — see get_session_status's nextQuestion"),
  optionId: z.string().nullish().describe("For choice questions: the chosen option id, or \"other\""),
  otherText: z.string().optional().describe("For choice questions with optionId=\"other\", or for plain text questions"),
  optionIds: z.array(z.string()).optional()
    .describe("For multi_choice questions (e.g. dietary): ALL chosen option ids at once. A multi_choice answer is the whole set — sending one id at a time discards the rest"),
  data: dataParam
    .describe("For structured questions only: an array (travelers, phases, travel_anchors) or object (constraints)"),
};
