// Captured shape of a real Envoy AI Gateway `/v1/responses` stream: a reasoning
// item followed by a message item, emitted **without** the `output_index` /
// `content_index` fields the canonical OpenAI Responses API always includes
// (the defect `responses-repair` fixes), and with the reasoning item's
// `output_item.done` arriving late — after the message item already opened.
//
// Used by both the hermetic e2e suite and as a reference for the live
// integration test. The model's answer is the single word `ok`.
export const NONCONFORMANT_RESPONSES_SSE = [
  `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n`,
  `event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"rs_1","type":"reasoning","content":[]}}\n\n`,
  `event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","item_id":"rs_1","delta":"thinking"}\n\n`,
  `event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n`,
  `event: response.content_part.added\ndata: {"type":"response.content_part.added","item_id":"msg_1","part":{"type":"output_text"}}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","delta":"ok"}\n\n`,
  `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning"}}\n\n`,
  `event: response.output_text.done\ndata: {"type":"response.output_text.done","item_id":"msg_1","text":"ok"}\n\n`,
  `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n`
].join("");
