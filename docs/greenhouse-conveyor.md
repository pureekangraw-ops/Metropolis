# Metro → Greenhouse → owner stations

City Hall owns Work identity, permission, lifecycle and authenticated intake. Greenhouse/PIXIE
owns durable delivery attempts. Factory and Observatory own their source evidence. GO/LIGHT
are submitters, not long-running runtime dependencies.

A station handoff enqueues the City-approved payload through GREENHOUSE_TRANSPORT and returns
Job ID/status. The queue consumer calls the existing signed City rail through METROPOLIS_SERVICE.
City Hall loads the saved job, rechecks the current Work/pass/grant, and uses FACTORY_SERVICE with
the Factory V2 HMAC adapter, or the existing Observatory snapshot reader. No user token crosses
this service boundary. Factory readback and Observatory receipts preserve Work/checkpoint.

Use metropolis_work handoff FACTORY_STATION with the destination operation for Factory.
Use OBSERVATORY_STATION / observe with payload.view=browser or map for an OBSERVATORY Work.
Observation requires per-Work READ plus handoff; it grants no browser command. GO and LIGHT
follow the same Work policy. A paired device must publish a fresh actual capture.

The same City's saved job yields the same receipt for duplicate delivery. Missing destinations
that prove no send may retry through Greenhouse up to five times. An ambiguous send is held for
readback, never replayed. Existing Work RETURN waits for verified delivery. READBACK_VERIFIED
is delivery evidence; business completion and MIMIR Work closure remain separate.

Existing Work continuity: WORK-190aa284-e3aa-4de9-90fd-d33c290ef236 (Greenhouse),
WORK-be5d7941-cf95-47e3-b150-e0aacc48e0f9 (Observatory). Never create a new Work to repair transport.
