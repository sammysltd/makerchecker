# makerchecker (Python SDK)

Govern AI-agent tool calls through MakerChecker from Python. This is a thin,
typed HTTP client over a running MakerChecker server plus the framework-agnostic
`governed_tool` wrapper. It adds no server logic and never touches the audit
core; it brings the same deny-by-default grants, segregation of duties, and
hash-chained signed audit to Python agents (CrewAI, LangChain-Python,
LlamaIndex, AutoGen, or a plain function).

```bash
pip install makerchecker
```

```python
from makerchecker import create_client, governed_tool, GovernanceDeniedError

client = create_client("http://localhost:3000", api_key="mk_...")
session = client.proxy.open_session("crew-run")["session"]

# Wrap any tool function: check -> (deny raises) -> run -> record.
ingest = governed_tool(
    client, session["id"], "recon-preparer", "csv-ingest@1",
    lambda i: read_csv(i["path"]),
)

result = ingest({"path": "statement.csv"})   # raises GovernanceDeniedError if denied
client.proxy.close_session(session["id"])
```

`governed_tool` does, on every call:

1. `client.proxy.check` — a deny raises `GovernanceDeniedError` **before** your
   tool runs (deny by default, fail closed);
2. runs your function;
3. records the output, or, if it raises, records the error and re-raises.

## CrewAI

CrewAI tools are plain callables under the hood, so wrap the implementation and
call it from your tool:

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

Apache-2.0: embedding this SDK in your own systems never carries AGPL
obligations. The MakerChecker server it talks to is AGPL-3.0.
