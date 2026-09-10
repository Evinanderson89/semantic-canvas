/** Report a failed write as a failed write, including structured validation errors. */
export async function readResponse<T = any>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? body?.issues?.map((i: any) => i.problem ?? i.message).join("; ") ?? `Request failed (${response.status})`);
  if (!body) throw new Error("The server returned an empty response");
  return body as T;
}
