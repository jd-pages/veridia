/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("node:module");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveVeridiaModule(
  request,
  parent,
  isMain,
  options,
) {
  const normalizedRequest =
    typeof request === "string" &&
    /^@prisma\/client-[a-f0-9]{16}$/i.test(request)
      ? "@prisma/client"
      : request;
  return originalResolveFilename.call(
    this,
    normalizedRequest,
    parent,
    isMain,
    options,
  );
};
