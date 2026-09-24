# Compatibility

The runtime asks each installed provider what it supports. Your doctor report is the best guide to the exact commands and app versions on your computer.

## What automated checks cover

The test suite checks protocol behavior with simulated Freebuff, OpenCode, Codex, Claude, and Cursor responses. It also checks unavailable-provider behavior, message delivery records, project path rules, credential handling, and verification working folders.

The benchmark runs three tasks against simulated providers. It observed zero duplicate sends in the current run. It does not measure completion quality, provider latency, or actual provider use.

GitHub CI checks three operating systems with four supported Node versions. The package supports Node 20 through Node 26.

## What has been tried with live providers

A Freebuff GLM 5.3 Flash session returned a response in an earlier local check.

An OpenCode Big Pickle session accepted a prompt. The final response was not observed.

These observations do not establish support for every version, account, model, or machine. There is no current four-provider live acceptance record.

## Readiness labels

`unavailable` means the provider could not be reached or initialized.

`discovered` means the provider answered discovery. It does not confirm sign in or completion.

`transport_accepted` means the provider endpoint accepted a request. It does not mean the work finished.

`delivery_unknown` means the connection failed when delivery could not be confirmed. Check the native provider session before sending the same work again.

`completed` should be used only when the provider reports completion. A separate verification check is needed before calling the result verified.
