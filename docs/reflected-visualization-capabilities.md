# Reflected visualization capability version 1

The catalog may advertise `capabilities["studio:visualization"]`. Studio validates
the version, renderer family, payload format, supported transports, and exact
parameter roles before creating a binding for any block ID. An absent capability
keeps the existing exact-ID adapter path. An invalid or unsupported advertised
capability remains unsupported and does not fall back to that path.

Version 1 retains explicit `routing: "session"` and the conventional transport
and endpoint role names. Keeping those fields makes protocol validation explicit
and preserves the current contract. The referenced settings must exist.
`family` remains separate from `payload_format`: dataset payloads may select a
series2d or histogram renderer, and scalar/status payloads have distinct renderer
choices. `semantic_kind` preserves presentation distinctions such as spectrum
and dataset behavior. Count, cadence, and other optional roles may vary.

Capabilities select existing renderer adapters; they do not supply executable
code or arbitrary runtime routes. Session stream descriptors own the resolved
routes, with payload and transport agreement checked at binding time. The
legacy canvas preview retains its existing interface.

The first audited producers are Series, PowerSpectrum, and Waterfall. Other
producers keep their existing adapters until their actual interfaces are audited.
Capability export, catalog transport, producer adoption, and the frontend consumer
are separately reviewable from setting policies and boolean conditions.
