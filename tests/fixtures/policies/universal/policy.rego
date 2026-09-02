package universal

decisions contains decision if {
	input.parsed.executable == "rm"
	decision := {"action": "deny", "reason": "rm is not allowed, use trash instead"}
}

decisions contains decision if {
	input.parsed.executable == "cat"
	decision := {"action": "allow"}
}
