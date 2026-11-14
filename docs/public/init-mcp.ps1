# This file is published as a static asset at:
#   https://machine-memory.jfa.dev/init-mcp.ps1
#
# MCP-only counterpart to `machine-memory init --mcp`.
# Creates or replaces the managed machine-memory block in ./AGENTS.md so agents
# that only have the remote MCP server (no CLI) follow the same workflow.
#
# Usage:
#   irm https://machine-memory.jfa.dev/init-mcp.ps1 | iex
#
# Environment:
#   MACHINE_MEMORY_AGENTS_MD  Path to write (default AGENTS.md).
#                             Absolute or relative to the current directory.

$ErrorActionPreference = "Stop"

$target = if ($env:MACHINE_MEMORY_AGENTS_MD) { $env:MACHINE_MEMORY_AGENTS_MD } else { "AGENTS.md" }
if ([System.IO.Path]::IsPathRooted($target)) {
  $agentsMd = $target
} else {
  $agentsMd = Join-Path (Get-Location) $target
}

# Managed block must stay in sync with agentsMdContent("mcp") in
# cli/src/cli/commands/agents-md-content.ts (base64 payload below).
$memoryBlockB64 = @'
PCEtLSBtYWNoaW5lLW1lbW9yeTpzdGFydCAtLT4KPCEtLSBtYWNoaW5lLW1lbW9yeTp2ZXJzaW9u
IDMgbWNwIC0tPgojIyBQcm9qZWN0IG1lbW9yeQoKVGhpcyByZXBvc2l0b3J5IGtlZXBzIGR1cmFi
bGUgcHJvamVjdCBrbm93bGVkZ2UgaW4gYG1hY2hpbmUtbWVtb3J5YCwgcmVhY2hlZCB0aHJvdWdo
IGl0cyBNQ1AgdG9vbHMgKGBsaXN0X3JlcG9zaXRvcmllc2AgYW5kIGBtZW1vcnlfKmApOyBubyBD
TEkgaXMgbmVlZGVkLiBFdmVyeSB0b29sIHRha2VzIGByZXBvc2l0b3J5YCwgdGhlIHBhdGggb2Yg
dGhpcyBjaGVja291dCdzIG9yaWdpbiByZW1vdGUsIHN1Y2ggYXMgYG93bmVyL25hbWVgLiBDb25m
aXJtIGl0IHdpdGggYGxpc3RfcmVwb3NpdG9yaWVzYCBiZWZvcmUgdGhlIGZpcnN0IHdyaXRlOiBh
IHdyb25nIHNsdWcgcmVhZHMgYXMgZW1wdHkgYW5kIHdyaXRlcyB0byBhIG5ldyByZXBvc2l0b3J5
LgoKLSBCZWZvcmUgY2hhbmdpbmcgY29kZSwgc2NhbiBvbmNlIGFuZCByZWFkIHRoZSByZWNvcmRz
IHRoYXQgYmVhciBvbiB0aGUgdGFzazogYG1lbW9yeV9zdWdnZXN0YCB3aXRoIGB7IHJlcG9zaXRv
cnksIGZpbGVzIH1gIGZvciBrbm93biBmaWxlcywgb3IgYG1lbW9yeV9xdWVyeWAgd2l0aCBgeyBy
ZXBvc2l0b3J5LCBxdWVyeSB9YCBmb3IgYSB0b3BpYyBvciBhIHRhc2sgdGhhdCB0b3VjaGVzIG5v
IGZpbGVzOyB0aGVuIGBtZW1vcnlfZ2V0YCBmb3IgZWFjaCBpZC4gUmVzdWx0cyBhcmUgY2FuZGlk
YXRlczoganVkZ2UgdGhlbSBieSBgbWF0Y2hfc3RyZW5ndGhgLCBhbmQgIm5vdGhpbmcgcmVsZXZh
bnQiIGlzIGEgdmFsaWQgb3V0Y29tZS4KLSBXaGVuIHRoZSB1c2VyJ3MgaW5zdHJ1Y3Rpb24gY29u
dHJhZGljdHMgYSBzdG9yZWQgcmVjb3JkLCBmb2xsb3cgdGhlIHVzZXIgYW5kIHVwZGF0ZSB0aGUg
cmVjb3JkLgotIFdyaXRlIG9uZSBmYWN0IHBlciByZWNvcmQgYW5kIHN0YXJ0IGl0IHdpdGggdGhl
IGNvbW1hbmQsIHBhdGggb3IgaWRlbnRpZmllciBpdCBpcyBhYm91dC4gU3RvcmUgZGVjaXNpb25z
LCBjb25zdHJhaW50cywgcHJlZmVyZW5jZXMsIHJlZmVyZW5jZXMgYW5kIGdvdGNoYXMuIFB1dCBk
ZWxpdmVyeSBzdGF0ZSBpbiBvbmUgYHN0YXR1c2AgcmVjb3JkIHdpdGggYGV4cGlyZXNfYWZ0ZXJf
ZGF5c2AuIExlYXZlIG91dCBwaXhlbCB2YWx1ZXMsIFVJIHN0YXRlIGFuZCBkZXBsb3kgb3V0Y29t
ZXMsIGFuZCBwdXQgZmFjdHMgYWJvdXQgb25lIG1hY2hpbmUgaW4gdGhhdCBtYWNoaW5lJ3MgZ3Vp
ZGFuY2UgZmlsZS4KLSBDaGVjayBzaXplIGJlZm9yZSB3cml0aW5nOiBgbWVtb3J5X3NpemVgIHdp
dGggdGhlIGNvbnRlbnQsIHRhZ3MgYW5kIGNvbnRleHQgeW91IGludGVuZCB0byB3cml0ZS4gQ29u
dGVudCwgdGFncyBhbmQgY29udGV4dCBzaGFyZSBvbmUgMiwwMDAtYnl0ZSBsaW1pdC4KLSBDaGFu
Z2UgYSByZWNvcmQgd2l0aCBgbWVtb3J5X3VwZGF0ZWAgKGBpZGAgYW5kIHRoZSB3aG9sZSBuZXcg
YGNvbnRlbnRgKS4gSXQgcmVwbGFjZXMgdGhlIGNvbnRlbnQsIHNvIHJlYWQgdGhlIHJlY29yZCBm
aXJzdCBhbmQga2VlcCB0aGUgZGV0YWlscyB0aGF0IHN0aWxsIGhvbGQuIENyZWF0ZSBvbmUgd2l0
aCBgbWVtb3J5X2FkZGAgYW5kIGB1cHNlcnRfbWF0Y2hgLCB3aGljaCB1cGRhdGVzIGEgc3Ryb25n
IG1hdGNoIGluc3RlYWQgb2YgYWRkaW5nIGEgZHVwbGljYXRlLgotIFdoZW4gYSB3cml0ZSByZXBv
cnRzIGBkcm9wcGVkYCBvciBgcmV2aWV3X2NhbmRpZGF0ZXNgLCByZXN0b3JlIGRldGFpbHMgZHJv
cHBlZCBieSBtaXN0YWtlIGFuZCB1cGRhdGUgb3IgZGVwcmVjYXRlIHRoZSBsaXN0ZWQgcmVjb3Jk
cy4KLSBgY2VydGFpbnR5OiB2ZXJpZmllZGAgcmVxdWlyZXMgYGV2aWRlbmNlYDogYHVzZXJfcmVx
dWlyZW1lbnRgLCBgb2JzZXJ2ZWRfaW1wbGVtZW50YXRpb25gLCBgdmVyaWZpZWRfbWVjaGFuaXNt
YCBvciBgdGVzdGVkX2JlaGF2aW9yYC4gUmVhZGluZyB0aGUgY29kZSBwcm92ZXMgb25seSBgb2Jz
ZXJ2ZWRfaW1wbGVtZW50YXRpb25gLgotIFdoZW4gZGVsZWdhdGluZywgc2NhbiBvbmNlIGFuZCBw
YXNzIHRoZSByZWNvcmQgaWRzIHRvIGNoaWxkIGFnZW50cy4gQ2hpbGRyZW4gcmV0dXJuIGZpbmRp
bmdzIHdpdGggdGhlaXIgZXZpZGVuY2U7IHRoZSBwYXJlbnQgd3JpdGVzIHRoZW0uCi0gQmVmb3Jl
IHRoZSBmaW5hbCByZXNwb25zZSwgbGlzdCB0aGlzIHRhc2sncyB3cml0ZXMgd2l0aCBgbWVtb3J5
X2xpc3RgIGFuZCB0aGUgcmVjb3JkcyBmb3IgdGhlIHRvdWNoZWQgZmlsZXMgd2l0aCBgbWVtb3J5
X3N1Z2dlc3RgLCB0aGVuIGFkZCwgdXBkYXRlIG9yIGRlcHJlY2F0ZSByZWNvcmRzIGZvciB3aGF0
IHRoZSB0YXNrIGVzdGFibGlzaGVkLgoKUHJvamVjdCBwcmVmZXJlbmNlOiByZXBsYWNlIG9ic29s
ZXRlIHN5c3RlbXMgd2hlbiBwcmFjdGljYWw7IHByZXNlcnZlIGJhY2t3YXJkcyBjb21wYXRpYmls
aXR5IG9ubHkgd2hlbiBpdCBpcyBleHBsaWNpdGx5IHJlcXVpcmVkLgo8IS0tIG1hY2hpbmUtbWVt
b3J5OmVuZCAtLT4=

'@

$cleanB64 = $memoryBlockB64 -replace '\s', ''
try {
  $managedBlock = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($cleanB64))
} catch {
  throw "machine-memory init-mcp: could not decode managed AGENTS.md block. $_"
}
if (-not $managedBlock.EndsWith("`n")) {
  $managedBlock += "`n"
}

$startMarker = '<!-- machine-memory:start -->'
$endMarker = '<!-- machine-memory:end -->'

if (Test-Path -LiteralPath $agentsMd -PathType Leaf) {
  $existing = [System.IO.File]::ReadAllText($agentsMd)
  $action = 'Updated'
} else {
  $existing = ''
  $action = 'Created'
  $parentDir = Split-Path -Parent $agentsMd
  if ($parentDir -and -not (Test-Path -LiteralPath $parentDir)) {
    New-Item -ItemType Directory -Force -Path $parentDir | Out-Null
  }
}

$s = $existing.IndexOf($startMarker)
$e = if ($s -ge 0) { $existing.IndexOf($endMarker, $s) } else { -1 }
if ($s -ge 0 -and $e -ge 0) {
  $after = $existing.Substring($e + $endMarker.Length)
  $out = $existing.Substring(0, $s) + $managedBlock.TrimEnd("`r", "`n") + "`n"
  if ($after) {
    $out += $after.TrimStart("`r", "`n")
    if (-not $out.EndsWith("`n")) {
      $out += "`n"
    }
  }
} else {
  $body = $existing.TrimEnd()
  $managedTrimmed = $managedBlock.TrimEnd("`r", "`n")
  if ($body) {
    $out = "$body`n`n$managedTrimmed`n"
  } else {
    $out = "$managedTrimmed`n"
  }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($agentsMd, $out, $utf8NoBom)

Write-Host "$action $agentsMd"
Write-Host "Backend  mcp (MCP tools; no CLI)"
Write-Host "Next     connect an OAuth MCP client to https://<worker-url>/mcp"
Write-Host "Docs     https://machine-memory.jfa.dev/docs/mcp/init"
