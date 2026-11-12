# Smolagents: A Comprehensive Introduction

`smolagents` is a lightweight, barebones library by Hugging Face designed to build powerful AI agents with minimal code. It prioritizes simplicity, efficiency, and first-class support for **Code Agents**—agents that express their actions through Python code rather than complex JSON structures.

---

## 🚀 Getting Started

### Installation

You can install `smolagents` via pip. It is recommended to install the `toolkit` extra for a full set of default tools.

```bash
pip install "smolagents[toolkit]"
```

---

## 🧠 Core Concepts

### 1. CodeAgent vs. ToolCallingAgent

`smolagents` offers two primary agent types:

*   **`CodeAgent`**: The flagship agent. It writes its actions as executable Python code snippets. This approach reduces the number of steps needed for complex tasks and is significantly more robust than traditional tool-calling.
*   **`ToolCallingAgent`**: A more traditional agent that communicates with tools via JSON/text blobs (similar to ReAct).

### 2. Why Code Agents?
Traditional agents often struggle with logic (loops, conditionals) when constrained to JSON schemas. By allowing the agent to write Python:
- **Efficiency:** Achieves goals in 30% fewer steps.
- **Logic:** Can natively use loops, variables, and data structures.
- **Performance:** Outperforms traditional methods on difficult benchmarks like GAIA.

---

## 🛠️ Defining Tools

Tools are the "hands" of your agent. In `smolagents`, you can define them in two ways:

### Method A: The `@tool` Decorator
Ideal for simple functions. The docstring and type hints are used to generate the tool's schema.

```python
from smolagents import tool

@tool
def get_weather(location: str) -> str:
    """
    Returns the current weather for a given location.
    Args:
        location: The city and country.
    """
    return f"The weather in {location} is sunny, 25°C."
```

### Method B: Subclassing `Tool`
Ideal for complex tools requiring state or initialization.

```python
from smolagents import Tool

class CustomSearchTool(Tool):
    name = "custom_search"
    description = "Searches the web for specific information."
    inputs = {"query": {"type": "string", "description": "The search query"}}
    output_type = "string"

    def forward(self, query: str):
        # Implementation logic here
        return f"Results for {query}"
```

---

## 🤖 Models & Providers

`smolagents` is model-agnostic. You can use models from:
- **Hugging Face Hub:** `InferenceClientModel` or `HfApiModel`.
- **Local Models:** `TransformersModel` (via `transformers`) or `LiteLLMModel` (for Ollama).
- **Proprietary APIs:** `OpenAIModel`, `AzureOpenAIModel`, `AmazonBedrockModel`, or `LiteLLMModel` (for Anthropic).

```python
from smolagents import HfApiModel

model = HfApiModel(model_id="Qwen/Qwen2.5-Coder-32B-Instruct")
```

---

## 🏃 Quick Start Example

Here is a simple `CodeAgent` that uses a web search tool to answer a complex question.

```python
from smolagents import CodeAgent, DuckDuckGoSearchTool, HfApiModel

# 1. Initialize the model
model = HfApiModel()

# 2. Create the agent with tools
agent = CodeAgent(
    tools=[DuckDuckGoSearchTool()], 
    model=model,
    add_base_tools=True # Adds helpful tools like 'print' or 'time'
)

# 3. Run the agent
agent.run("Who won the 2024 F1 World Championship and by how many points?")
```

---

## 🛡️ Security & Sandboxing

Because `CodeAgent` executes Python code, security is paramount. `smolagents` provides several options for secure execution:
- **Local Execution:** Only a limited, safe subset of Python is allowed by default.
- **E2B/Modal/Docker:** For full, unrestricted Python execution, you can use sandboxed environments.
- **Pyodide+Deno:** A WebAssembly-based sandbox for browser or edge environments.

---

## 👯 Multi-Agent Systems

You can build complex workflows by letting one agent manage others. A "manager" agent treats other agents as tools.

```python
from smolagents import CodeAgent

research_agent = CodeAgent(tools=[...], model=model, name="research_agent", description="Performs deep research")
manager_agent = CodeAgent(tools=[research_agent], model=model)

manager_agent.run("Research the impact of AI on agriculture and write a summary.")
```

---

## 🌐 Hub Integration

Share your tools and agents easily on the Hugging Face Hub:

```python
# Push to Hub
agent.push_to_hub("your-username/my-cool-agent")

# Load from Hub
from smolagents import CodeAgent
agent = CodeAgent.from_hub("your-username/my-cool-agent")
```

---

## 📚 Advanced Features
- **Vision & Multi-modality:** Agents can process images, video, and audio.
- **MCP Support:** Use tools from any Model Context Protocol (MCP) server.
- **LangChain/LlamaIndex Integration:** Easily wrap tools from other ecosystems.

For more details, visit the [official smolagents documentation](https://huggingface.co/docs/smolagents).
