const protobuf = require('protobufjs');
const KEYS = [132, 94, 78, 66, 57, 162, 31, 96, 28];
// Matches the current official client's ActionPrototype transform (v0.11.252.w).
function transformAction(bytes) {
  const data = Buffer.from(bytes);
  for (let i = 0; i < data.length; i++) data[i] ^= ((23 ^ data.length) + 5 * i + KEYS[i % 9]) & 255;
  return data;
}
class Protocol {
  constructor(schema) { this.setSchema(schema); this.connections = new Map(); }
  setSchema(schema) { this.root = protobuf.Root.fromJSON(schema).resolveAll(); }
  decodeType(name, bytes) {
    const type = this.root.lookupType(name);
    return type.toObject(type.decode(bytes), {defaults: true, bytes: Buffer, longs: Number});
  }
  decodeAction(action, encoded = true) {
    const name = action.name.startsWith('lq.') || action.name.startsWith('.lq.') ? action.name : `lq.${action.name}`;
    const data = this.decodeType(name, encoded ? transformAction(action.data) : action.data);
    return {name, data, step: action.step, ...(!encoded ? {replay:true} : {})};
  }
  close(connection) { this.connections.delete(connection); }
  frame(connection, direction, bytes) {
    const b = Buffer.from(bytes);
    if (!b.length || ![1, 2, 3].includes(b[0])) return [];
    if (b[0] !== 1 && b.length < 3) throw new Error('Truncated RPC frame');
    if (!this.connections.has(connection)) this.connections.set(connection, new Map());
    const pending = this.connections.get(connection);
    const wrapper = this.decodeType('lq.Wrapper', b.subarray(b[0] === 1 ? 1 : 3));
    const index = b[0] === 1 ? 0 : b.readUInt16LE(1);
    if (b[0] === 2 && direction === 'send') {
      const method = this.root.lookup(wrapper.name);
      if (!method || !method.responseType) return [];
      pending.set(index, {name: wrapper.name, response: method.resolvedResponseType.fullName, request: this.decodeType(method.resolvedRequestType.fullName, wrapper.data)});
      if (pending.size > 2048) pending.delete(pending.keys().next().value);
      if (/^\.?lq\.FastTest\.input(?:ChiPengGang|Operation)$/.test(wrapper.name)) return [{name:'operationSent',data:{method:wrapper.name}}];
      return [];
    }
    if (direction !== 'receive') return [];
    let event;
    if (b[0] === 3) {
      const call = pending.get(index);
      if (!call) return [];
      pending.delete(index);
      event = {name: call.name, data: this.decodeType(call.response, wrapper.data), request: call.request};
    } else if (b[0] === 1) {
      event = {name: wrapper.name, data: this.decodeType(wrapper.name, wrapper.data)};
    } else return [];
    if (event.name.endsWith('ActionPrototype')) return [this.decodeAction(event.data)];
    if (event.data.error?.code || event.data.is_end) return [event];
    if (event.data.game_restore) {
      const restore = event.data.game_restore;
      const actions = restore.actions || [];
      // Replays contain plain protobuf and restart from the round's first action.
      const events = restore.snapshot ? [{name: 'restore', data: restore.snapshot, step: actions.length ? actions[0].step - 1 : event.data.step}] : [{name: 'restoreStart', data: {}}];
      for (const action of actions) events.push(this.decodeAction(action, false));
      return events;
    }
    return [event];
  }
}
module.exports = {Protocol, transformAction};
