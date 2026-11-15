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
IDQgbWNwIC0tPgojIyBQcm9qZWN0IG1lbW9yeQoKVGhpcyByZXBvc2l0b3J5IGtlZXBzIGR1cmFi
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
aXJzdCBhbmQga2VlcCB0aGUgZGV0YWlscyB0aGF0IHN0aWxsIGhvbGQuIE9taXQgYGNvbnRlbnRg
IHRvIGNoYW5nZSBvbmx5IHRhZ3MsIHR5cGUgb3IgY2VydGFpbnR5LiBDcmVhdGUgb25lIHdpdGgg
YG1lbW9yeV9hZGRgIGFuZCBgdXBzZXJ0X21hdGNoYCwgd2hpY2ggdXBkYXRlcyBhIHN0cm9uZyBt
YXRjaCBpbnN0ZWFkIG9mIGFkZGluZyBhIGR1cGxpY2F0ZS4KLSBXaGVuIGEgd3JpdGUgcmVwb3J0
cyBgZHJvcHBlZGAgb3IgYHJldmlld19jYW5kaWRhdGVzYCwgcmVzdG9yZSBkZXRhaWxzIGRyb3Bw
ZWQgYnkgbWlzdGFrZSBhbmQgdXBkYXRlIG9yIGRlcHJlY2F0ZSB0aGUgbGlzdGVkIHJlY29yZHMu
Ci0gYGNlcnRhaW50eTogdmVyaWZpZWRgIHJlcXVpcmVzIGBldmlkZW5jZWA6IGB1c2VyX3JlcXVp
cmVtZW50YCwgYG9ic2VydmVkX2ltcGxlbWVudGF0aW9uYCwgYHZlcmlmaWVkX21lY2hhbmlzbWAg
b3IgYHRlc3RlZF9iZWhhdmlvcmAuIFJlYWRpbmcgdGhlIGNvZGUgcHJvdmVzIG9ubHkgYG9ic2Vy
dmVkX2ltcGxlbWVudGF0aW9uYC4KLSBXaGVuIGRlbGVnYXRpbmcsIHNjYW4gb25jZSBhbmQgcGFz
cyB0aGUgcmVjb3JkIGlkcyB0byBjaGlsZCBhZ2VudHMuIENoaWxkcmVuIHJldHVybiBmaW5kaW5n
cyB3aXRoIHRoZWlyIGV2aWRlbmNlOyB0aGUgcGFyZW50IHdyaXRlcyB0aGVtLgotIEJlZm9yZSB0
aGUgZmluYWwgcmVzcG9uc2UsIGxpc3QgdGhpcyB0YXNrJ3Mgd3JpdGVzIHdpdGggYG1lbW9yeV9s
aXN0YCBhbmQgdGhlIHJlY29yZHMgZm9yIHRoZSB0b3VjaGVkIGZpbGVzIHdpdGggYG1lbW9yeV9z
dWdnZXN0YCwgdGhlbiBhZGQsIHVwZGF0ZSBvciBkZXByZWNhdGUgcmVjb3JkcyBmb3Igd2hhdCB0
aGUgdGFzayBlc3RhYmxpc2hlZC4KClByb2plY3QgcHJlZmVyZW5jZTogcmVwbGFjZSBvYnNvbGV0
ZSBzeXN0ZW1zIHdoZW4gcHJhY3RpY2FsOyBwcmVzZXJ2ZSBiYWNrd2FyZHMgY29tcGF0aWJpbGl0
eSBvbmx5IHdoZW4gaXQgaXMgZXhwbGljaXRseSByZXF1aXJlZC4KPCEtLSBtYWNoaW5lLW1lbW9y
eTplbmQgLS0+

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
