/** Read-only message retrieval; Chrome storage and the durable journal stay in the worker. */
export interface JournalTransport {
  readonly sendMessage: (message: { readonly type: "CHATGPT_JOURNAL_READ" }) => Promise<unknown>;
}

export interface JournalReader {
  readonly read: () => Promise<unknown>;
}
