# Cephalon v3.0.0 — Release notes

Cephalon 3.0 replaces the previous desktop shell with a native application using GPUI-CE. In the project's local comparison, it used over 32% less RAM and felt more responsive. It also brings major improvements to scientific document search and evidence handling.

Jina's reranker currently requires the specific llama.cpp build described in [LOCAL_STARTUP_NOTES.md](LOCAL_STARTUP_NOTES.md). The embedding and reranking models may change in future releases.

## Highlights

### A new native desktop app

- Replaced the previous web-based desktop shell with a native Cephalon desktop app for Windows and Linux.
- Kept the main workflow together in one workspace: Library, Chat, Sources, Retrieval Trace, Health, Evaluations, and Settings.
- Packaged builds start Cephalon’s local backend automatically, while the chat model remains a separate server that you control.
- Improved startup and connection feedback so it is clear whether the local service, chat server, and active chat model are ready.
- Polished Markdown display, text entry, scrolling, narrow-window behavior, and error messages.

### Answers built around better evidence

- Search now combines meaning-based matches with exact-word matches before ranking all promising results.
- Citations continue to point to the passage that supports an answer, while related headings, nearby passages, parent context, captions, tables, and page continuations can be added when they improve understanding.
- Source selection considers which parts of a question are still unanswered, helping the final context cover the important evidence instead of simply taking the highest-scoring passages.
- Thorough mode can make one focused follow-up search when important evidence is missing and can make one focused correction pass when the draft needs it. Quick and Balanced modes avoid these extra passes.
- Sources and retrieval traces expose where an answer came from and how the final evidence was selected.

### Better citations and answer checks

- PDF evidence now retains useful structure such as pages, headings, captions, figures, tables, and bounding boxes when available.
- Cited claims are checked for missing support, contradictions, incorrect numbers or units, negation errors, and missing citations.
- Clean final prose is shown and saved without hidden model-reasoning blocks.
- Repeatable checks recompute supported numerical claims rather than trusting a generated result blindly.

### Structured questions over tables

- PDF, CSV, and XLSX tables are indexed as structured data as well as readable text.
- Table questions can perform bounded lookups, filters, comparisons, and basic calculations such as totals, averages, minimums, maximums, counts, differences, and percentages.
- Results preserve table, row, column, and cell details so answers can point back to the exact cells used.
- Table results and their supporting evidence remain available in streamed answers, saved conversations, Sources, and diagnostics.

### Clearer local model and retrieval management

- Settings now manages and verifies the fixed local retrieval models: Jina Embeddings v5 Nano and Jina Reranker v3.5.
- The retrieval services can use Vulkan hardware acceleration where supported and show a clear warning when reranking is unavailable instead of silently changing how results are ranked.
- If the embedder is unavailable, Cephalon clearly reports that document search is unavailable.
- Chat-server status now reflects the model actually active on the server, not only a configured label.
- Empty, unfinished, hidden-reasoning-only, or otherwise invalid streamed answers are rejected with a useful error.
- Stale indexes are detected automatically, with reindex controls and progress reporting.

### Diagnostics, evaluation, and packaging

- Health, Index Health, Retrieval Trace, Answer Support, and Evaluation views now expose more useful information when something needs investigation.
- Added repeatable retrieval and answer-quality checks, regression fixtures, and coverage for the new PDF and table evidence paths.
- Updated release packaging for the native app and refreshed Windows/Linux setup guidance, including the bundled Python backend.
- Removed the former ONNX retrieval workflow and unused legacy desktop code in favor of the single llama.cpp-based retrieval path.

## Upgrade notes

This release changes both the desktop client and the retrieval models. After upgrading:

1. Follow the updated setup instructions in [README.md](README.md) and [LOCAL_STARTUP_NOTES.md](LOCAL_STARTUP_NOTES.md).
2. Start your external llama.cpp chat server as before; Cephalon does not bundle a chat model or llama.cpp.
3. Install and verify the Jina retrieval models from **Settings**, then restart Cephalon.
4. Reindex the document library. Indexes created by the older retrieval setup must be rebuilt before retrieval can be used.
5. If you want GPU-accelerated reranking, complete the helper setup described in [LOCAL_STARTUP_NOTES.md](LOCAL_STARTUP_NOTES.md). Without it, Cephalon shows a retrieval warning and continues with a simpler ranking path.
