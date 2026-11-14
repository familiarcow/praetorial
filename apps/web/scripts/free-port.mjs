// Prints a free TCP port chosen by the OS (bind port 0). Used by test.sh's 'web e2e (mocked)' step (FE1b).
import net from "node:net";
const s = net.createServer();
s.listen(0, "127.0.0.1", () => {
  const { port } = s.address();
  s.close(() => console.log(port));
});
