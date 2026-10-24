import bcrypt from "bcryptjs";

const COST = 12;

export const hashPassword = (password: string) => bcrypt.hash(password, COST);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

// Compared against when the account does not exist, so response time doesn't reveal which emails are registered.
let dummyHash: string | undefined;
export const getDummyHash = () => (dummyHash ??= bcrypt.hashSync("timing-equaliser", COST));
