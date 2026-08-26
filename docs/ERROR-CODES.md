# Error Code Reference

Every failure kyzerdocs-lite can show you carries one of the codes below. If something goes
wrong, look up the code here first — it tells you what actually happened and what to do next. If
you need to contact support, include the code; it is the fastest way to start from a known state.

This file is generated directly from the app's error registry (`src/lib/errors.ts`) and cannot
drift from what the app actually does — do not hand-edit it.

| Code | What it means | What to do |
|---|---|---|
| KDL-CFG-001 | GEMINI_API_KEY is not set. | Add GEMINI_API_KEY to your .env.local — get one at https://aistudio.google.com/apikey. |
| KDL-CFG-002 | ADMIN_PASSWORD is not set. | Add ADMIN_PASSWORD to your .env.local — set it to any password you choose. |
| KDL-CFG-003 | The configured API key was rejected by the provider. | Check that GEMINI_API_KEY is correct and has not been revoked, then try again. |
| KDL-CFG-004 | Your OpenRouter chat provider key was rejected. | Check that your optional OpenRouter chat key is correct and has not been revoked, then try again. |
| KDL-DB-001 | The database file could not be opened. | Check that DATABASE_PATH points to a writable location and the disk has free space. |
| KDL-DB-002 | A database schema migration failed. | Check the server logs for the failing statement, then restart the app. |
| KDL-UPLOAD-001 | This file type is not supported. | Upload a PDF, DOCX, TXT, or MD file. |
| KDL-UPLOAD-002 | This file is too large. | Upload a smaller file, or split it into multiple documents. |
| KDL-UPLOAD-003 | This file is empty. | Upload a file that contains content. |
| KDL-PARSE-001 | No text could be extracted — this looks like a scanned PDF with no text layer. | Upload a text-based PDF, or run this file through OCR first. |
| KDL-PARSE-002 | This PDF is password-protected. | Remove the password protection and re-upload the file. |
| KDL-PARSE-003 | This file could not be read — it may be unreadable or corrupt. | Re-export or re-save the file, then try uploading it again. |
| KDL-PARSE-004 | Text extraction from this DOCX file failed. | Re-save the file from its original application and try again. |
| KDL-EMBED-001 | The embedding API rate limit or quota was exhausted. | Wait a few minutes and try again, or check your AI Studio quota. |
| KDL-EMBED-002 | The embedding API could not be reached. | Check your network connection and try again. |
| KDL-EMBED-003 | An embedding failed its normalization check. | This is an internal error — please retry; if it persists, report it with this code. |
| KDL-INGEST-001 | Document ingestion failed. | Check the document status for details, then retry the upload. |
| KDL-INGEST-002 | Document ingestion was interrupted and can be resumed. | Retry the upload — ingestion will continue from where it left off. |
| KDL-AUTH-001 | Incorrect password. | Check ADMIN_PASSWORD in your .env.local and try again. |
| KDL-AUTH-002 | Too many login attempts. | Wait a few minutes before trying again. |
| KDL-AUTH-003 | You are not signed in. | Sign in with the admin password to continue. |
| KDL-CHAT-001 | No documents have been indexed yet. | Upload at least one document before asking a question. |
| KDL-CHAT-002 | The answer was refused because the retrieved passages do not answer the question. | Rephrase the question, or upload a document that covers this topic. |
| KDL-CHAT-003 | The chat model could not be reached. | Check your network connection and API key, then try again. |
| KDL-CHAT-004 | The chat request was malformed and the server rejected it. | This is a bug in the app, not a problem with your key or connection. Reload the page and ask again — if it keeps happening, quote KDL-CHAT-004 in a support message. |
| KDL-WIDG-001 | This website is not on the allowed-domains list for this knowledge base. | Add this domain in the Widget screen's Allowed domains list, then reload the page. |
| KDL-WIDG-002 | This chat is getting a lot of questions right now. | Please try again in a minute. |
| KDL-WIDG-003 | No knowledge base matches this id. | Check the data-kb-id value in your install snippet against the one shown on the Widget screen. |
| KDL-WIDG-004 | The widget request was malformed and the server rejected it. | This is a bug in the app, not a problem with your site. Reload the page and ask again — if it keeps happening, quote KDL-WIDG-004 in a support message. |
| KDL-WIDG-005 | This chat is not available right now. | The site owner needs to finish configuring their deployment — quote KDL-WIDG-005 to them. |
| KDL-DB-003 | The database could not be reached. | Check that DATABASE_URL is correct and the database is running, then try again. |
| KDL-DB-004 | The database schema is missing or out of date. | Run `npm run db:migrate` against your DATABASE_URL, then restart the app. |
| KDL-DB-005 | The configured database is not a recognized Neon host. | Check DATABASE_URL — it must point at a Neon Postgres database (host ending in neon.tech), not any other provider. |
| KDL-BLOB-001 | File storage is not configured for this deployment. | Connect a Blob store to your Vercel project and redeploy. If one is already connected, open it, create a read-write token, add it to the project as BLOB_READ_WRITE_TOKEN, and redeploy. |
| KDL-BLOB-002 | The uploaded file could not be stored. | Check that the Blob store still exists and its token has not been revoked, then re-upload. |
| KDL-BLOB-003 | The stored copy of this document could not be read. | Re-upload the document — its stored copy is missing or unreadable. |
| KDL-BLOB-005 | Document uploads are unavailable on this deployment. | Open your Blob store in Vercel, create a read-write token, add it to the project as BLOB_READ_WRITE_TOKEN, and redeploy. A store connected without one can store files but cannot accept browser uploads. |
| KDL-BLOB-004 | Blob storage could not be reached. | Check that your Blob store still exists and BLOB_READ_WRITE_TOKEN is correct, then try again. |
| KDL-WIDG-006 | The widget configuration you submitted is invalid. | Check each field — domain format, accent colour, title length — and try again. |
