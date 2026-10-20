// the names of the doc tools. the policy, the session lists and the sub-agent profiles import them, so this file
// imports nothing.

export const DOC_READ_TOOLS: readonly string[] = ['doc_list', 'doc_read', 'doc_search'];
// the write tools change only the local database, so a builtin rule of the policy allows them without a review.
export const DOC_WRITE_TOOLS: readonly string[] = ['doc_update', 'doc_write'];
// the main session and the automations get every doc tool. the research profile of a sub-agent gets the read tools,
// once the tools exist.
export const DOC_TOOLS: readonly string[] = [...DOC_READ_TOOLS, ...DOC_WRITE_TOOLS];
