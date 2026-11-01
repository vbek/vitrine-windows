// Account recovery from the machine running the studio, with no web-facing bypass.
// Usage: npm run reset-password -- <username> <new-password>
import { get, run } from './db.js';
import { hashPassword, validatePassword } from './auth.js';

const [cmd, username, password] = process.argv.slice(2);
if (cmd !== 'reset-password' || !username || !password) {
  console.error('Usage: npm run reset-password -- <username> <new-password>');
  process.exit(1);
}
const user = get('SELECT id FROM users WHERE username=?', username);
if (!user) { console.error(`No user named "${username}"`); process.exit(1); }
validatePassword(password);
run('UPDATE users SET password_hash=?, totp_enabled=0, totp_secret=NULL, active=1 WHERE id=?', hashPassword(password), user.id);
run('DELETE FROM sessions WHERE user_id=?', user.id);
console.log(`Password reset and two-factor cleared for "${username}".`);
