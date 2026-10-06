import test from 'node:test';
import assert from 'node:assert/strict';
import { createStationAnnouncement } from '../src/station-announcement.mjs';
test('Station only announces canonical current version and schema', () => { const announcement = createStationAnnouncement({ version: '1.1.0', schema: 'city-v1', source: 'canonical://metropolis/current' }); assert.equal(announcement.readOnly, true); assert.equal(announcement.source, 'canonical://metropolis/current'); });
