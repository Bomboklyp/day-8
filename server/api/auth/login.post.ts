import { defineEventHandler, readBody } from "h3";
import { createSession } from "../../utils/auth";
import { loginSchema, parseInput } from "../../utils/schemas";
import { authenticate } from "../../services/auth";
export default defineEventHandler(async (event) => {
  const user = await authenticate(
    parseInput(loginSchema, await readBody<unknown>(event)),
  );
  await createSession(event, user);
  return { user };
});
