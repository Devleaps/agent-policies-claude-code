package measurable

# Mirrors the real pip_install.rego shape: ask for pypi_metadata if it hasn't
# been looked up yet, then allow/deny based on the resolved age.
decisions[decision] if {
	input.command == "install-package"
	pkg := input.package
	not input.pypi_lookup_attempted[pkg]
	decision := {"action": "incomplete", "require": [{"kind": "pypi_metadata", "package": pkg}]}
}

decisions[decision] if {
	input.command == "install-package"
	pkg := input.package
	input.pypi_metadata[pkg].age_days >= 365
	decision := {"action": "allow"}
}

decisions[decision] if {
	input.command == "install-package"
	pkg := input.package
	input.pypi_lookup_attempted[pkg]
	not input.pypi_metadata[pkg]
	decision := {"action": "deny", "reason": "not found"}
}

# Two requires in one decision, exercising the same-kind-different-params case.
decisions[decision] if {
	input.command == "install-two-packages"
	not input.pypi_lookup_attempted.alpha
	not input.pypi_lookup_attempted.beta
	decision := {
		"action": "incomplete",
		"require": [
			{"kind": "pypi_metadata", "package": "alpha"},
			{"kind": "pypi_metadata", "package": "beta"},
		],
	}
}

decisions[decision] if {
	input.command == "install-two-packages"
	input.pypi_metadata.alpha.age_days >= 365
	input.pypi_metadata.beta.age_days >= 365
	decision := {"action": "allow"}
}

# Asks for a resolver kind that will never be registered client-side.
decisions[decision] if {
	input.command == "unknown-kind"
	decision := {"action": "incomplete", "require": [{"kind": "totally_made_up_kind"}]}
}

# Buggy policy: always incomplete, even after being given what it asked for.
decisions[decision] if {
	input.command == "always-incomplete"
	decision := {"action": "incomplete", "require": [{"kind": "pypi_metadata", "package": "whatever"}]}
}

# Plain command needing no measurement at all.
decisions[decision] if {
	input.command == "plain-allow"
	decision := {"action": "allow"}
}
