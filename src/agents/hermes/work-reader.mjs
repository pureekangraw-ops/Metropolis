// HERMES reads existing Work truth on behalf of an authorized GO/LIGHT actor.
// It does not own Work state, mint authority, or mutate a Work record.
const nonBlank = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + '_REQUIRED');
  return value.trim();
};

export function createHermesWorkReader({ getWork, mayRead } = {}) {
  if (typeof getWork !== 'function' || typeof mayRead !== 'function') throw new Error('HERMES_READER_DEPENDENCIES_REQUIRED');

  async function read({ actor, workId } = {}) {
    const requestedBy = nonBlank(actor, 'ACTOR');
    const id = nonBlank(workId, 'WORK_ID');
    const record = await getWork(id);
    if (!record) throw new Error('WORK_NOT_FOUND');

    // Never act on HERMES identity as a substitute for caller Work authority.
    if (await mayRead({ actor: requestedBy, record }) !== true) throw new Error('NO_GRANT');

    const readback = await getWork(id);
    if (!readback || JSON.stringify(readback) !== JSON.stringify(record)) {
      throw new Error('READBACK_MISMATCH');
    }

    return {
      actor: requestedBy,
      handledBy: 'HERMES',
      workId: id,
      checkpointId: readback.checkpointId,
      record: readback,
      readbackVerified: true,
      ownerExecutionVerified: false,
      workTruthChanged: false,
      receipt: {
        operation: 'READ_WORK',
        handledBy: 'HERMES',
        requestedBy,
        workId: id,
        checkpointId: readback.checkpointId,
        readbackVerified: true,
        observedAt: new Date().toISOString(),
        persisted: false,
      },
    };
  }

  return Object.freeze({ read });
}
