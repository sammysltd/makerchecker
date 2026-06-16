# makerchecker (Python SDK)

A typed HTTP client for a running MakerChecker server, plus the
framework-agnostic `governed_tool` wrapper. The package contains no governance
logic. The server enforces deny-by-default skill grants, segregation of duties,
n-of-m approval gates, per-skill role limits, and the hash-chained,
Ed25519-signed audit. This SDK opens a proxy session over HTTP and routes tool
calls through it so a Python agent (CrewAI, LangChain-Python, LlamaIndex,
AutoGen, or a plain function) is governed by those rules.

The API mirrors the TypeScript SDK at [../sdk](../sdk).

## Install

```bash
pip install makerchecker
```

Requires Python 3.9+. The only runtime dependency is `httpx`.

## Exports

```python
from makerchecker import (
    create_client,         # () -> Client
    Client,                # API client
    CheckResult,           # outcome of a proxy check
    ApiError,              # raised on non-2xx HTTP responses
    governed_tool,         # wrap a tool function
    GovernanceDeniedError, # raised when a check denies a call
)
```

## create_client

```python
def create_client(base_url: str, api_key: str | None = None) -> Client
```

Constructs a `Client` for `base_url`. When `api_key` is given it is sent as
`Authorization: Bearer <api_key>` on every request. Equivalent to
`Client(base_url, api_key)`.

```python
from makerchecker import create_client

client = create_client("http://localhost:3000", api_key="mk_...")
```

## Client

```python
class Client:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        http: httpx.Client | None = None,
    ) -> None
```

Pass `http` to inject a configured `httpx.Client` (used in tests with a mock
transport). When omitted, the client creates an `httpx.Client` for `base_url`
with the Bearer header and a 30-second timeout, and closes it on `close()`. A
client whose `http` was injected does not own that transport and leaves it open.

`Client` is a context manager:

```python
with create_client("http://localhost:3000", api_key="mk_...") as client:
    client.health()
```

Any response with status >= 400 raises `ApiError(status, body)`.

### Top-level methods

```python
client.health() -> dict                    # GET  /healthz
client.trigger_flow(name, input=None)      # POST /api/flows/{name}/runs
client.verify_audit() -> dict              # GET  /api/audit/verify
client.close() -> None
```

`trigger_flow` sends `input` as the request body (an empty object when omitted)
and URL-encodes `name`.

### client.proxy

The proxy surface is the per-call governance checkpoint. The flow per tool call
is: open a session once, then `check` then `record` for each call, then close
the session.

```python
client.proxy.open_session(label, external_ref=None) -> dict
client.proxy.check(session_id, agent_name, skill_ref, input=None) -> CheckResult
client.proxy.record(session_id, check_id, output=..., error=...) -> dict
client.proxy.close_session(session_id) -> dict
client.proxy.get_session(session_id) -> dict
```

`open_session` returns the server response `{"session": {...}}`. The session
object carries an `id`:

```python
session = client.proxy.open_session("crew-run")["session"]
session_id = session["id"]
```

`check` returns a `CheckResult`. An allowed result has `check_id`; a denied
result has `code` and `reason`. A deny is a decision, not an HTTP error: the
server returns 200 with `allowed=False`.

`record` reports the result of a call back to the server, keyed by the
`check_id` from a prior allowed `check`. Pass `output` for success or `error`
for failure. Both arguments use a sentinel default, so `output=None` records a
literal `None` output and is distinct from omitting `output`.

`close_session` closes the session. `get_session` returns the session record
with its actions and audit events.

## CheckResult

```python
@dataclass(frozen=True)
class CheckResult:
    allowed: bool
    check_id: str | None = None   # set when allowed
    code: str | None = None       # set when denied
    reason: str | None = None     # set when denied
```

`allowed` is the discriminator. Reading the result directly:

```python
result = client.proxy.check(session_id, "recon-preparer", "csv-ingest@1",
                            input={"path": "statement.csv"})
if result.allowed:
    out = read_csv("statement.csv")
    client.proxy.record(session_id, result.check_id, output=out)
else:
    print(result.code, result.reason)
```

## governed_tool

```python
def governed_tool(
    client: Client,
    session_id: str,
    agent_name: str,
    skill_ref: str,
    fn: Callable[[dict], T],
) -> Callable[[dict], T]
```

Returns a wrapped version of `fn`. The wrapper takes the tool input as a dict
and, on every call:

1. calls `client.proxy.check(session_id, agent_name, skill_ref, input=input)`.
   A denied result raises `GovernanceDeniedError(code, reason)` before `fn`
   runs.
2. runs `fn(input)`.
3. on success, calls `client.proxy.record(session_id, check_id, output=...)`
   and returns the output. If `fn` raises, calls
   `record(session_id, check_id, error={"message": str(err)})` and re-raises the
   original exception.

`skill_ref` is a `name@version` string, for example `csv-ingest@1`. The version
is pinned: a grant for one version does not authorize another.

```python
from makerchecker import create_client, governed_tool, GovernanceDeniedError

client = create_client("http://localhost:3000", api_key="mk_...")
session = client.proxy.open_session("crew-run")["session"]

ingest = governed_tool(
    client, session["id"], "recon-preparer", "csv-ingest@1",
    lambda i: read_csv(i["path"]),
)

try:
    result = ingest({"path": "statement.csv"})
except GovernanceDeniedError as err:
    print(err.code, err.reason)

client.proxy.close_session(session["id"])
```

## GovernanceDeniedError

```python
class GovernanceDeniedError(Exception):
    code: str
    reason: str
```

Raised by a `governed_tool` wrapper when `check` denies the call, before `fn`
runs. The message is `governance denied (<code>): <reason>`.

## ApiError

```python
class ApiError(Exception):
    status: int   # HTTP status code
    body: str     # raw response body
```

Raised by any client method when the server returns a status >= 400. A denied
`check` does not raise this: it returns a `CheckResult` with `allowed=False`.

## CrewAI

CrewAI tools are callables. Wrap the implementation with `governed_tool` and
call it from the tool:

```python
from crewai.tools import tool

ingest = governed_tool(client, session["id"], "recon-preparer", "csv-ingest@1",
                       lambda i: read_csv(i["path"]))

@tool("csv_ingest")
def csv_ingest(path: str) -> str:
    """Ingest the statement CSV."""
    return ingest({"path": path})
```

## LangChain (Python)

```python
from langchain_core.tools import tool

match = governed_tool(client, session["id"], "recon-preparer", "txn-match@1",
                      lambda i: match_txns(i))

@tool
def txn_match(statement: list, ledger: list) -> dict:
    """Match transactions."""
    return match({"statement": statement, "ledger": ledger})
```

## Limitations

The SDK is a stateless HTTP client. Session lifecycle is the caller's
responsibility: open a session before wrapping tools, pass its `id` to
`governed_tool`, and close it when the run ends. `governed_tool` records a tool
exception as `{"message": str(err)}`; it does not capture tracebacks or
structured error fields.

## License

Apache-2.0. Embedding this SDK in your own systems carries no AGPL obligation.
The MakerChecker server it talks to is AGPL-3.0.
