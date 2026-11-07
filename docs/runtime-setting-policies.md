# Runtime controls and declared update policies

Direct parameter controls and the inspector allow writable settings with an
unspecified policy to be edited manually. Declared stopped-only or topology
settings are disabled while running. Configure those settings in the graph and
run it again; the current settings API does not edit a retained stopped instance.
Missing metadata disables writes while runtime values remain readable.

Automatic expression propagation requires an explicit live declaration. This
rollout keeps that rule and reports skipped expression dependencies in runtime
status. Mixed variables can still affect local displays and eligible live
settings; skipped settings are listed with the reason they need another run or
lack a live declaration. A successful request is described as staged, not as
confirmed application. Unresolved expressions never supply a fallback value.
Runtime variable overrides remain separate from the saved graph.

Supported adoption is deliberately bounded:

| Use case | Policy and workflow |
| --- | --- |
| Audited Series, PowerSpectrum, and Waterfall display settings | Explicit live declarations in the sink producer policy PR |
| Sink transport, endpoint, and captured update interval | Stopped-only; edit configuration and run again |
| Port-count settings | Topology; reconfigure the graph |
| SignalGenerator tone frequency | Explicit live in the separate standard-block producer PR; native regression verifies the staged update changes running output |
| Other unannotated standard-block settings | Unclassified for automatic propagation; status explains the skipped dependency |

Do not infer live support from a parameter name, a block ID, writability, or an
expression binding. Additional producer adoption requires checking how the
processing path observes staged changes and testing the running behavior.
