// HTTP error type carrying a status code, so domain code can fail cleanly and
// the router maps it to a response body the web client already understands
// ({ error, issues }).
export class HttpError extends Error {
  readonly status: number
  readonly issues: Array<{ path: string; message: string }>

  constructor(status: number, message: string, issues: HttpError["issues"] = []) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.issues = issues
  }
}

export function zodIssues(error: { issues?: Array<{ path: (string | number)[]; message: string }> }): Array<{ path: string; message: string }> {
  return (error.issues ?? []).map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
  }))
}
