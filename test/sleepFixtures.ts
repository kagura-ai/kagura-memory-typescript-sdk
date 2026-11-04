/** Required SleepReportDetail report fields; envelope action_count stays explicit. */
export function sleepReport(reportId: string) {
  return {
    report_id: reportId, status: "completed",
    memories_processed: 0, edges_created: 0, memories_merged: 0,
    memories_promoted: 0, llm_calls_made: 0, llm_tokens_used: 0,
    memories_flagged: 0, embedding_calls_made: 0,
  };
}
