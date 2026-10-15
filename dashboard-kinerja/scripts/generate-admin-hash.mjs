import { randomBytes, scryptSync } from 'node:crypto';

if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('Jalankan dari terminal interaktif agar kata sandi tidak terlihat.');
  process.exitCode = 1;
} else {
  process.stdout.write('Kata sandi Admin (tidak ditampilkan): ');
  let password = '';
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', chunk => {
    for (const char of chunk) {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        if (password.length < 12) {
          console.error('Gunakan setidaknya 12 karakter.');
          process.exitCode = 1;
        } else {
          const salt = randomBytes(16);
          const digest = scryptSync(password, salt, 32);
          console.log(`DASHBOARD_ADMIN_PASSWORD_SCRYPT=${salt.toString('hex')}:${digest.toString('hex')}`);
        }
        password = '';
        return;
      }
      if (char === '\u0003') {
        process.stdin.setRawMode(false); process.stdin.pause(); password = ''; process.exitCode = 1; return;
      }
      if (char === '\u007f' || char === '\b') password = password.slice(0, -1);
      else password += char;
    }
  });
}
