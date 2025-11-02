import crypto from "crypto";

const { LICENSE_SECRET = "dev_license_secret" } = process.env;

export function hmacHex(input) {
  return crypto.createHmac("sha256", LICENSE_SECRET).update(input).digest("hex");
}
