# agent-policies-claude-code

Policies allow your rules, often in natural language, to be expressed as policies; code. The policies are strict guardrails an AI Agent cannot bypass or disregard. Policies allow you to automate decisionmaking as well as guidance for AI Agents, letting them self-correct without interruption.

> This repository contains only the Claude Code client. For the server reference implementation, see [agent-policies-server](https://github.com/Devleaps/agent-policies-server).

## Installation

```bash
claude plugin marketplace add Devleaps/marketplace
claude plugin install agent-policies@Devleaps-marketplace
```

## Architecture

```mermaid
graph TB
    subgraph "Developer Machine"
        Editor[Claude Code]
        Client[agent-policies-claude-code]
    end

    subgraph "Policy Server"
        Server[HTTP API]
        Policies[Your policies<br/>kubectl, terraform, git, python, etc.]
    end

    Editor -->|PreToolUse / PostToolUse| Client
    Client --> Server
    Server -->|Events| Policies
    Policies -->|Decision and Guidance| Server
    Server --> Client
    Client -->|Decision and Guidance| Editor
```

## Configuration

`~/.agent-policies/config.json`:

```jsonc
{
  // Policy server endpoint. Default: "https://agent-policies.devleaps.nl"
  "server_url": "http://localhost:8338",

  // Policy bundles to activate. Default: ["universal"]
  "bundles": ["universal", "python", "git"],

  // What to do when the server returns no decision: "allow", "ask", "deny". Default: "ask"
  "default_policy_behavior": "ask"
}
