# Metropolis System Map v1

**Status:** topology contract / no runtime binding

The map is a shared interpretation contract. It is not a live-state mirror and it does not create new operational authority.

## Topology

```text
METROPOLIS
├── SHOP / SPECTRUMSALE
├── THE TAILOR
├── HALL
│   ├── HERMES → HERMES SECRETARY
│   ├── WORK SYSTEM
│   └── MIMIR → MIMIR SECRETARY
├── PIXIE SERVICE
├── POST OFFICE
├── RAIL
└── STATIONS
    ├── FACTORY STATION → FACTORY
    ├── PRISM STATION → PRISM
    ├── DRIVE STATION → GOOGLE DRIVE
    └── NOTION STATION → NOTION
```

- HALL is one workplace inside METROPOLIS, not the whole city.
- HERMES, WORK SYSTEM and MIMIR remain in that order.
- Secretaries are attached to their Agent; they are not a central Post Office secretary.
- THE TAILOR and PIXIE SERVICE are outside HALL.
- SHOP / SPECTRUMSALE is a city building, not a Shop Station.
- Drive and Notion have separate Stations.
- Path is local movement inside the city or a workspace. Rail crosses system boundaries through a Station.
- Rail carries both people/agents and data/cargo.
- POST OFFICE handles data/cargo, not people/agent movement.

The executable source is `src/system-map-v1.mjs`. Validate changes with `validateSystemMapV1` before rendering a new visual map.
