package universal

decisions contains d if {
	input.parsed.executable == "cat"
	d := {"action": "allow"}
}

decisions contains d if {
	input.parsed.executable == "rm"
	d := {"action": "deny", "reason": "rm is not allowed, use trash instead"}
}

decisions contains d if {
	input.event.tool_name == "WebFetch"
	input.event.parameters.host == "github.com"
	d := {"action": "allow"}
}
