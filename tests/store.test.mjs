import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { totp, verifyTotp, generateSecret } from '../server/totp.js';

test('users, friends, messages, invites, roles', async () => {
  const store = createStore({ persist: false });
  const a = await store.createUser({ username: 'Аня', password: 'secret1', bio: 'hi' });
  const b = await store.createUser({ username: 'boris', password: 'secret1' });
  assert.equal(store.getUserByName('аня').id, a.id);
  await assert.rejects(() => store.createUser({ username: 'аня', password: 'xxxx' }));
  assert.equal(await store.checkPassword(a, 'secret1'), true);
  const req = store.friendRequest(a.id, b.id);
  store.acceptRequest(req.id, b.id);
  assert.ok(store.friendsOf(a.id).some((u) => u.id === b.id));
  const g = store.createGroup({ name: 'Дом', ownerId: a.id });
  store.setMember(g.id, b.id, 'member');
  assert.equal(store.memberRole(g.id, a.id), 'admin');
  const text = store.createChannel({ groupId: g.id, name: 'общий', type: 'text' });
  const ann = store.createChannel({ groupId: g.id, name: 'анонсы', type: 'announcement' });
  const voice = store.createChannel({ groupId: g.id, name: 'Голос', type: 'voice' });
  assert.equal(store.channelsOf(g.id).length, 3);
  const msg = store.addMessage({ convoId: text.id, fromId: a.id, text: 'привет **мир**' });
  store.react(msg.id, b.id, '❤️');
  store.pin(msg.id, true);
  const edited = store.editMessage(msg.id, a.id, 'исправлено');
  assert.equal(edited.edited, true);
  const page = store.queryMessages(text.id, { limit: 10, q: 'исправ' });
  assert.equal(page.messages.length, 1);
  const inv = store.createInvite({ groupId: g.id, creatorId: a.id, maxUses: 1, expiresIn: 60_000 });
  const c = await store.createUser({ username: 'cara', password: 'secret1' });
  store.consumeInvite(inv.code, c.id);
  assert.equal(store.memberRole(g.id, c.id), 'member');
  assert.equal(store.consumeInvite(inv.code, a.id).id, g.id);
  const d = await store.createUser({ username: 'dina', password: 'secret1' });
  assert.throws(() => store.consumeInvite(inv.code, d.id));
  assert.equal(ann.type, 'announcement');
  assert.equal(voice.type, 'voice');
  store.block(a.id, b.id);
  assert.equal(store.isBlocked(a.id, b.id), true);
});

test('totp window', () => {
  const secret = generateSecret();
  const code = totp(secret);
  assert.equal(verifyTotp(secret, code), true);
  assert.equal(verifyTotp(secret, '000000'), false);
});

test('pagination hasMore', async () => {
  const store = createStore({ persist: false });
  const a = await store.createUser({ username: 'pager', password: 'secret1' });
  for (let i = 0; i < 45; i++) store.addMessage({ convoId: 'saved:' + a.id, fromId: a.id, text: 'm' + i });
  const page = store.queryMessages('saved:' + a.id, { limit: 40 });
  assert.equal(page.messages.length, 40);
  assert.equal(page.hasMore, true);
  assert.equal(page.messages[0].text, 'm5');
});
