# Troubleshooting

Start with `agent-interop-runtime doctor`. It reports which providers answered and why an unavailable provider could not start.

## No provider is available

Open the provider app or install its command line tool. Confirm that you can use it directly. Restart the MCP client after changing server settings.

## A message says `delivery_unknown`

The provider may have received the request before the connection failed. Open that exact native session and check its history. Do not resend until you know whether the first request started.

## OpenCode cannot connect

Check that `opencode serve` works locally. Set `OPENCODE_SERVER_URL` when the server uses another address. Remote servers need HTTPS plus a username and password.

## Freebuff CLI does not start

Confirm `FREEBUFF_CLI_PATH` points to the executable. Confirm `FREEBUFF_PROJECT_ROOT` points to the project. From a source checkout, run `pnpm pty:probe` to check the terminal dependency.

## Project file access is refused

Check the selected project path. The runtime refuses paths outside that folder, common credential files, binary data, and files larger than one megabyte.

## Verification refuses a working folder

The requested folder must exist inside the named workspace. A symbolic link or Windows junction that points outside the workspace is refused. Commands still run with the permissions of the local user.
