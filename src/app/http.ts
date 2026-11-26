import { issuesText } from "../compiler/issueText.ts";
/** Report a failed write as a failed write, including structured validation errors. */
export async function readResponse<T = any>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(body?.error ?? (body?.issues ? issuesText(body.issues) : undefined) ?? `Request failed (${response.status})`);
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }
  if (!body) throw new Error("The server returned an empty response");
  return body as T;
}
