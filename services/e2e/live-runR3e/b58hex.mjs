import { utils } from "near-api-js";
console.log(Buffer.from(utils.serialize.base_decode(process.argv[2].replace("ed25519:",""))).toString("hex"));
