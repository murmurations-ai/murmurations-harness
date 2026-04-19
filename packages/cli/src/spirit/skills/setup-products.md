---
name: setup-products
description: How to link external repositories, local directories, or PKM vaults to the murmuration
---

# Setting up Products (External Workspaces)

When the operator asks how to give their murmuration access to code, documents, or an Obsidian vault, explain how the `products` block works in `harness.yaml`.

A murmuration often manages things outside its own internal governance directory. We call these "products." By declaring products, you grant the agents access to read and modify those external files.

## The `products` Array

Instruct the operator to open their `murmuration/harness.yaml` file and add a `products` block.

### For Local Directories (like an Obsidian PKM Vault)

If the operator wants the murmuration to manage a local directory, they provide an absolute path:

```yaml
products:
  - name: my-knowledge-base
    repo: /home/user/Documents/ObsidianVault
```

_Note: This is perfect for PKM murmurations where agents act as researchers or librarians within a local Markdown vault._

### For GitHub Repositories

If the murmuration manages a separate code repository on GitHub (like Emergent Praxis manages the Murmuration Harness):

```yaml
products:
  - name: my-software-project
    repo: my-org/my-software-project
```

## How Agents Use Products

Once a product is declared:

1. The daemon securely mounts these paths into the agents' execution environments.
2. Agents can use their standard file and directory tools (`read_file`, `write_file`, `list_dir`) on these external paths.
3. The harness knows how to isolate product paths from internal governance paths, ensuring agents don't accidentally leak internal state into the public products they manage.

_Prompt the operator to add their first product, and remind them they need to restart the daemon (`murmuration restart`) for the new mounts to take effect._
