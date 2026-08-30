package universal

decisions contains decision if {
	input.parsed.executable == "cat"
	decision := {"action": "allow"}
}

decisions contains decision if {
	input.parsed.executable == "rm"
	decision := {"action": "deny", "reason": "rm is not allowed, use trash instead"}
}

decisions contains decision if {
	input.event.tool_name == "WebFetch"
	input.event.parameters.host == "github.com"
	decision := {"action": "allow"}
}

# File-edit guidance fixtures, mirroring the real
# policies/universal/file_edit_guidance.rego shape end-to-end.

decisions contains decision if {
	endswith(input.file_path, ".py")
	not input.measurements.comment_overlap
	decision := {"action": "incomplete", "require": [{"kind": "comment_overlap"}]}
}

guidances contains guidance if {
	input.measurements.comment_overlap.ratio >= 0.4
	guidance := {"content": "Ensure comments add value beyond describing what's obvious from the code."}
}

decisions contains decision if {
	endswith(input.file_path, ".py")
	not input.measurements.legacy_code
	decision := {"action": "incomplete", "require": [{"kind": "legacy_code"}]}
}

guidances contains guidance if {
	input.measurements.legacy_code.matched
	guidance := {"content": "Is backwards compatibility actually a requirement here? If it was not explicitly requested, check with the user before adding it."}
}

# Session-flag fixtures, exercising the real end-to-end session_flags
# round trip: client reads input.session_flags, and a decision's `flags`
# array is applied back to disk by client.js after the query.

decisions contains decision if {
	input.parsed.executable == "git"
	input.parsed.subcommand == "commit"
	decision := {"action": "allow", "flags": [{"name": "committed", "value": true}]}
}

decisions contains decision if {
	input.parsed.executable == "git"
	input.parsed.subcommand == "push"
	not input.session_flags.committed
	decision := {"action": "deny", "reason": "commit before pushing"}
}
