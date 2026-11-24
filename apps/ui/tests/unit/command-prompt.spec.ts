import { describe, expect, it } from 'vitest'
import type { CommandPrompt } from '@/lib/command-prompt'
import { pendingPrompt, terminalText } from '@/lib/command-prompt'

describe('terminalText', () => {
  it('drops escape sequences and lets carriage returns rewrite their line', () => {
    expect(terminalText(['\x1b[32mDownloading 10%', '\rDownloading 100%\x1b[0m\r\n', 'done'])).toBe('Downloading 100%\ndone')
  })

  it('returns an empty text for an empty output', () => {
    expect(terminalText([])).toBe('')
    expect(terminalText([''])).toBe('')
  })

  it('keeps plain text unchanged', () => {
    expect(terminalText(['Installing dependencies\n', 'added 12 packages in 2s\n'])).toBe('Installing dependencies\nadded 12 packages in 2s\n')
  })

  it('joins chunks split in the middle of a line', () => {
    expect(terminalText(['Proj', 'ect na', 'me: '])).toBe('Project name: ')
  })

  it('drops escape sequences split across chunks', () => {
    expect(terminalText(['\x1b[3', '2mgreen\x1b', '[0m', ' and \x1b]0;ti', 'tle\x07plain'])).toBe('green and plain')
  })

  it.each([
    { name: 'a reset', sequence: '\x1b[m' },
    { name: 'a numbered reset', sequence: '\x1b[0m' },
    { name: 'combined attributes', sequence: '\x1b[0;1;31m' },
    { name: 'a 256 color', sequence: '\x1b[38;5;208m' },
    { name: 'a true color', sequence: '\x1b[38;2;255;100;0m' },
    { name: 'an erase to end of line', sequence: '\x1b[K' },
    { name: 'an erase of the whole line', sequence: '\x1b[2K' },
    { name: 'a scrollback clear', sequence: '\x1b[3J' },
    { name: 'a cursor position', sequence: '\x1b[12;40H' },
    { name: 'a cursor column', sequence: '\x1b[1G' },
    { name: 'a cursor move up', sequence: '\x1b[1A' },
    { name: 'a private hide cursor', sequence: '\x1b[?25l' },
    { name: 'a private show cursor', sequence: '\x1b[?25h' },
    { name: 'a bracketed paste mode', sequence: '\x1b[?2004h' },
    { name: 'a device attributes request', sequence: '\x1b[>0c' },
    { name: 'a cursor shape with an intermediate byte', sequence: '\x1b[2 q' }
  ])('drops the CSI sequence of $name', ({ sequence }) => {
    expect(terminalText([`before${sequence}after`])).toBe('beforeafter')
  })

  it.each([
    { name: 'a window title', sequence: '\x1b]0;~/project\x07' },
    { name: 'a window title without icon', sequence: '\x1b]2;npm install\x07' },
    { name: 'a working directory', sequence: '\x1b]7;file://host/Users/me/project\x07' },
    { name: 'a shell integration mark', sequence: '\x1b]133;A\x07' },
    { name: 'an empty payload', sequence: '\x1b]\x07' }
  ])('drops the OSC sequence of $name terminated by BEL', ({ sequence }) => {
    expect(terminalText([`before${sequence}after`])).toBe('beforeafter')
  })

  it.each([
    { name: 'a window title', sequence: '\x1b]0;~/project\x1b\\' },
    { name: 'a terminal specific value', sequence: '\x1b]1337;CurrentDir=/tmp\x1b\\' },
    { name: 'a shell integration mark', sequence: '\x1b]133;D;0\x1b\\' }
  ])('drops the OSC sequence of $name terminated by ST', ({ sequence }) => {
    expect(terminalText([`before${sequence}after`])).toBe('beforeafter')
  })

  it('keeps the text of a hyperlink', () => {
    expect(terminalText(['see \x1b]8;;https://example.com/docs\x1b\\the docs\x1b]8;;\x1b\\ for help'])).toBe('see the docs for help')
  })

  it.each([
    { name: 'a reverse index', sequence: '\x1bM' },
    { name: 'an index', sequence: '\x1bD' },
    { name: 'a next line', sequence: '\x1bE' },
    { name: 'a tab set', sequence: '\x1bH' },
    { name: 'a string terminator', sequence: '\x1b\\' },
    { name: 'the lowest final byte', sequence: '\x1b@' },
    { name: 'the last capital final byte', sequence: '\x1bZ' }
  ])('drops the single character ESC sequence of $name', ({ sequence }) => {
    expect(terminalText([`before${sequence}after`])).toBe('beforeafter')
  })

  it.each([
    { name: 'a charset designation', sequence: '\x1b(B' },
    { name: 'a line drawing charset in G1', sequence: '\x1b)0' },
    { name: 'a cursor save', sequence: '\x1b7' },
    { name: 'a full reset', sequence: '\x1bc' },
    { name: 'a device control string', sequence: '\x1bP+q544e\x1b\\' },
    { name: 'an application program command', sequence: '\x1b_Gi=1\x1b\\' }
  ])('drops $name with its payload', ({ sequence }) => {
    expect(terminalText([`before${sequence}after`])).toBe('beforeafter')
  })

  it('drops consecutive escape sequences', () => {
    expect(terminalText(['\x1b[1m\x1b[32m\x1b]0;title\x07ok\x1b[39m\x1b[22m\x1bM'])).toBe('ok')
  })

  it('keeps bracketed text that has no escape character', () => {
    expect(terminalText(['values[0m] and [32m'])).toBe('values[0m] and [32m')
  })

  it('turns CRLF line endings into line feeds', () => {
    expect(terminalText(['first\r\nsecond\r\n'])).toBe('first\nsecond\n')
  })

  it('turns several carriage returns before a line feed into one line feed', () => {
    expect(terminalText(['first\r\r\nsecond\r\r\r\n'])).toBe('first\nsecond\n')
  })

  it('keeps only the text after the last carriage return of a line', () => {
    expect(terminalText(['Downloading 10%\rDownloading 55%\rDownloading 100%'])).toBe('Downloading 100%')
  })

  it('drops a carriage return at the start of a line', () => {
    expect(terminalText(['\rReady'])).toBe('Ready')
  })

  it('lets a carriage return rewrite only its own line', () => {
    expect(terminalText(['first\nsecond 1/2\rsecond 2/2\nthird'])).toBe('first\nsecond 2/2\nthird')
  })

  it('applies carriage returns split across chunks', () => {
    expect(terminalText(['50%\r', '100%\n'])).toBe('100%\n')
    expect(terminalText(['line\r', '\nnext'])).toBe('line\nnext')
  })

  it('drops escape sequences before applying carriage returns', () => {
    expect(terminalText(['done\r\x1b[K\n'])).toBe('done\n')
  })

  it('keeps the final frame of a spinner that erases its line', () => {
    expect(terminalText(['\x1b[2K\r⠋ Installing', '\x1b[2K\r⠙ Installing', '\x1b[2K\r✔ Installed\n'])).toBe('✔ Installed\n')
  })

  it('keeps blank lines', () => {
    expect(terminalText(['a\n\n', 'b\n\n\n'])).toBe('a\n\nb\n\n\n')
  })
})

describe('pendingPrompt', () => {
  it('finds a question on the last line that is not blank', () => {
    expect(pendingPrompt('Building...\nProject name: \n\n')).toEqual({ text: 'Project name:', secret: false, choice: null })
  })

  it('ignores output that does not end with a question', () => {
    expect(pendingPrompt('Done.\n')).toBeNull()
  })

  it.each(['', '   ', '\n\n  \n\t\n'])('returns null for the blank output %j', text => {
    expect(pendingPrompt(text)).toBeNull()
  })

  it.each([
    { end: ':', question: 'Project name:' },
    { end: '?', question: 'Continue?' },
    { end: ']', question: 'Select a region [eu-west-1]' },
    { end: ')', question: 'package name: (my-app)' },
    { end: '>', question: 'What now>' }
  ])('finds a question ending with $end', ({ question }) => {
    expect(pendingPrompt(`Starting\n${question} `)?.text).toBe(question)
  })

  it('trims the spaces around the question', () => {
    expect(pendingPrompt('  \tName:   \t')?.text).toBe('Name:')
  })

  it('finds a question without any line feed', () => {
    expect(pendingPrompt('Name:')?.text).toBe('Name:')
  })

  it('skips trailing lines made only of spaces', () => {
    expect(pendingPrompt('Step 1\nName: \n   \n\t\n')?.text).toBe('Name:')
  })

  it('keeps the whole last line', () => {
    expect(pendingPrompt('Fetching keys\nUsing key ABC: continue?')?.text).toBe('Using key ABC: continue?')
  })

  it('only looks at the last line', () => {
    expect(pendingPrompt('Project name:\nScaffolding project in ./demo')).toBeNull()
    expect(pendingPrompt('Project name: demo\nDone.\n')).toBeNull()
  })

  it.each([
    'Done.',
    'Compiling 12 files',
    'Downloading 100%',
    'Listening on http://localhost:5173/',
    'Ready in 320 ms',
    'Error: build failed',
    'name: demo',
    'Continue [Y/n] or abort',
    'user@host:~/project$',
    '#'
  ])('does not take %j for a question', line => {
    expect(pendingPrompt(`${line}\n`)).toBeNull()
  })

  it('marks questions asking for a secret', () => {
    expect(pendingPrompt('Enter passphrase for key:')?.secret).toBe(true)
    expect(pendingPrompt('PIN:')?.secret).toBe(true)
    expect(pendingPrompt('Spinning:')?.secret).toBe(false)
  })

  it.each([
    'Password:',
    'password:',
    'PASSWORD:',
    'New password:',
    'Retype new passwords:',
    'Enter passphrase:',
    'Passphrase?',
    'Client secret:',
    'SECRET KEY:',
    'API token:',
    'Personal access token (classic):',
    'Tokens:',
    'GITHUB_TOKEN:',
    'Token for the registry?',
    'PIN:',
    'pin:',
    'Enter PIN for authenticator:',
    'Card (pin):',
    'SIM pin-code:'
  ])('marks %j as asking for a secret', question => {
    expect(pendingPrompt(question)?.secret).toBe(true)
  })

  it.each([
    'Username:',
    'Email:',
    'Spinning up workers?',
    'Pinned version:',
    'Shipping address:',
    'Opinion:',
    'Pinpoint the file:',
    'Passport number:',
    'Bypass the cache?',
    'Tokenizer path:',
    'Detokenize the input?',
    'Use the tokenized output?'
  ])('does not mark %j as asking for a secret', question => {
    expect(pendingPrompt(question)?.secret).toBe(false)
  })

  it('reads yes/no answers and their default', () => {
    expect(pendingPrompt('Continue? [Y/n]')?.choice).toEqual({ yes: 'y', no: 'n', defaultAnswer: 'yes' })
    expect(pendingPrompt('Continue? [y/N]')?.choice).toEqual({ yes: 'y', no: 'n', defaultAnswer: 'no' })
    expect(pendingPrompt('Overwrite (yes/no)?')?.choice).toEqual({ yes: 'yes', no: 'no', defaultAnswer: null })
  })

  it.each([
    { question: 'Continue? [Y/n]', yes: 'y', no: 'n', defaultAnswer: 'yes' },
    { question: 'Continue? [y/N]', yes: 'y', no: 'n', defaultAnswer: 'no' },
    { question: 'Continue? [y/n]', yes: 'y', no: 'n', defaultAnswer: null },
    { question: 'Continue? [Y/N]', yes: 'y', no: 'n', defaultAnswer: null },
    { question: 'Continue (Y/n)?', yes: 'y', no: 'n', defaultAnswer: 'yes' },
    { question: 'Continue (y/N)?', yes: 'y', no: 'n', defaultAnswer: 'no' },
    { question: 'Proceed (y/n)?', yes: 'y', no: 'n', defaultAnswer: null },
    { question: 'Overwrite (yes/no)?', yes: 'yes', no: 'no', defaultAnswer: null },
    { question: 'Overwrite [yes/no]', yes: 'yes', no: 'no', defaultAnswer: null },
    { question: 'Overwrite (Yes/no)?', yes: 'yes', no: 'no', defaultAnswer: 'yes' },
    { question: 'Overwrite (yes/No)?', yes: 'yes', no: 'no', defaultAnswer: 'no' },
    { question: 'Overwrite (YES/NO)?', yes: 'yes', no: 'no', defaultAnswer: null },
    { question: 'Overwrite (Yes/No)?', yes: 'yes', no: 'no', defaultAnswer: null },
    { question: 'Overwrite [yes/n]', yes: 'yes', no: 'n', defaultAnswer: null },
    { question: 'Proceed [ Y / n ]', yes: 'y', no: 'n', defaultAnswer: 'yes' },
    { question: 'Proceed (y/ N)', yes: 'y', no: 'n', defaultAnswer: 'no' },
    { question: 'Proceed [Y /n]:', yes: 'y', no: 'n', defaultAnswer: 'yes' },
    { question: 'Delete [y/N] >', yes: 'y', no: 'n', defaultAnswer: 'no' },
    { question: 'Continue connecting (yes/no/[fingerprint])?', yes: 'yes', no: 'no', defaultAnswer: null },
    { question: 'Continue (yes / no / [fingerprint])?', yes: 'yes', no: 'no', defaultAnswer: null },
    { question: 'overwrite b.txt? (y/n [n])', yes: 'y', no: 'n', defaultAnswer: 'no' },
    { question: 'overwrite b.txt? (y/n [y])', yes: 'y', no: 'n', defaultAnswer: 'yes' },
    { question: 'Replace? [yes/no [yes]]', yes: 'yes', no: 'no', defaultAnswer: 'yes' },
    { question: 'Replace? (Y/n [N])', yes: 'y', no: 'n', defaultAnswer: 'no' }
  ])('reads the answers of $question', ({ question, yes, no, defaultAnswer }) => {
    expect(pendingPrompt(question)?.choice).toEqual({ yes, no, defaultAnswer })
  })

  it.each([
    'Project name:',
    'package name: (my-app)',
    'Is this OK? (yes)',
    'Ok to proceed? (y)',
    'Select an option (1/2/3):',
    '(1/1) Stage this hunk [y,n,q,a,d,e,?]?',
    'Continue? [n/y]',
    'Continue? yes/no?',
    'Continue? (y/n [maybe])',
    'Continue? (y/n/x)'
  ])('has no answers for %j', question => {
    expect(pendingPrompt(question)?.choice).toBeNull()
  })

  it('marks a yes/no question about a secret', () => {
    expect(pendingPrompt('Save password to the keychain? [y/N]')).toEqual({
      text: 'Save password to the keychain? [y/N]',
      secret: true,
      choice: { yes: 'y', no: 'n', defaultAnswer: 'no' }
    })
  })

  it.each<{ tool: string, output: string, prompt: CommandPrompt }>([
    {
      tool: 'ssh asking for a password',
      output: 'me@example.com\'s password: ',
      prompt: { text: 'me@example.com\'s password:', secret: true, choice: null }
    },
    {
      tool: 'ssh asking for a key passphrase',
      output: 'Enter passphrase for key \'/Users/me/.ssh/id_ed25519\': ',
      prompt: { text: 'Enter passphrase for key \'/Users/me/.ssh/id_ed25519\':', secret: true, choice: null }
    },
    {
      tool: 'ssh-keygen asking for a file',
      output: 'Generating public/private ed25519 key pair.\nEnter file in which to save the key (/Users/me/.ssh/id_ed25519): ',
      prompt: { text: 'Enter file in which to save the key (/Users/me/.ssh/id_ed25519):', secret: false, choice: null }
    },
    {
      tool: 'sudo on Linux',
      output: '[sudo] password for me: ',
      prompt: { text: '[sudo] password for me:', secret: true, choice: null }
    },
    {
      tool: 'sudo on macOS',
      output: 'Password:',
      prompt: { text: 'Password:', secret: true, choice: null }
    },
    {
      tool: 'git asking for a username',
      output: 'Cloning into \'repo\'...\nUsername for \'https://github.com\': ',
      prompt: { text: 'Username for \'https://github.com\':', secret: false, choice: null }
    },
    {
      tool: 'git asking for a password',
      output: 'Password for \'https://me@github.com\': ',
      prompt: { text: 'Password for \'https://me@github.com\':', secret: true, choice: null }
    },
    {
      tool: 'git add --patch',
      output: '@@ -1,3 +1,4 @@\n+added line\n(1/1) Stage this hunk [y,n,q,a,d,e,?]? ',
      prompt: { text: '(1/1) Stage this hunk [y,n,q,a,d,e,?]?', secret: false, choice: null }
    },
    {
      tool: 'git clean --interactive',
      output: '*** Commands ***\n    1: clean    2: filter by pattern    3: select by numbers\nWhat now> ',
      prompt: { text: 'What now>', secret: false, choice: null }
    },
    {
      tool: 'apt install',
      output: 'After this operation, 12.3 MB of additional disk space will be used.\nDo you want to continue? [Y/n] ',
      prompt: { text: 'Do you want to continue? [Y/n]', secret: false, choice: { yes: 'y', no: 'n', defaultAnswer: 'yes' } }
    },
    {
      tool: 'npm init asking for a name',
      output: 'Press ^C at any time to quit.\npackage name: (devtool) ',
      prompt: { text: 'package name: (devtool)', secret: false, choice: null }
    },
    {
      tool: 'npm init asking for a version',
      output: 'version: (1.0.0) ',
      prompt: { text: 'version: (1.0.0)', secret: false, choice: null }
    },
    {
      tool: 'npm init asking for a confirmation',
      output: '  "license": "ISC"\n}\n\n\nIs this OK? (yes) ',
      prompt: { text: 'Is this OK? (yes)', secret: false, choice: null }
    },
    {
      tool: 'npx installing a package',
      output: 'Need to install the following packages:\ncreate-vite@6.0.0\nOk to proceed? (y) ',
      prompt: { text: 'Ok to proceed? (y)', secret: false, choice: null }
    },
    {
      tool: 'npm login',
      output: 'Username: me\nPassword: ',
      prompt: { text: 'Password:', secret: true, choice: null }
    },
    {
      tool: 'ssh asking to trust a host key',
      output: 'ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ',
      prompt: {
        text: 'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
        secret: false,
        choice: { yes: 'yes', no: 'no', defaultAnswer: null }
      }
    },
    {
      tool: 'BSD cp in interactive mode',
      output: 'overwrite b.txt? (y/n [n]) ',
      prompt: { text: 'overwrite b.txt? (y/n [n])', secret: false, choice: { yes: 'y', no: 'n', defaultAnswer: 'no' } }
    },
    {
      tool: 'rm in interactive mode',
      output: 'remove notes.txt? ',
      prompt: { text: 'remove notes.txt?', secret: false, choice: null }
    },
    {
      tool: 'a Python REPL',
      output: 'Python 3.12.0\n>>> ',
      prompt: { text: '>>>', secret: false, choice: null }
    }
  ])('reads the prompt of $tool', ({ output, prompt }) => {
    expect(pendingPrompt(output)).toEqual(prompt)
  })
})

describe('pendingPrompt of terminalText', () => {
  it('finds a colored prompt', () => {
    const output = ['\x1b[32m?\x1b[39m \x1b[1mPackage name\x1b[22m\x1b[0m \x1b[2m(my-app)\x1b[22m \x1b[?25h']
    expect(pendingPrompt(terminalText(output))).toEqual({ text: '? Package name (my-app)', secret: false, choice: null })
  })

  it('finds a prompt written after a progress bar', () => {
    const output = ['Downloading 10%\r', 'Downloading 100%\r\n', 'Proceed? [Y/n] ']
    expect(pendingPrompt(terminalText(output))?.choice).toEqual({ yes: 'y', no: 'n', defaultAnswer: 'yes' })
  })

  it('finds a prompt that overwrites a progress line', () => {
    const output = ['Resolving 3/10\rResolving 10/10', '\r\x1b[KContinue? [y/N] ']
    expect(pendingPrompt(terminalText(output))?.text).toBe('Continue? [y/N]')
  })

  it('finds a prompt split across chunks after a window title', () => {
    const output = ['\x1b]0;ssh host\x07', 'me@host\'s pass', 'word: ']
    expect(pendingPrompt(terminalText(output))).toEqual({ text: 'me@host\'s password:', secret: true, choice: null })
  })

  it('finds a prompt followed by a charset designation and a reset', () => {
    expect(pendingPrompt(terminalText(['Name: \x1b(B\x1b[m']))).toEqual({ text: 'Name:', secret: false, choice: null })
  })

  it('finds a prompt written after a terminal capability query', () => {
    expect(pendingPrompt(terminalText(['\x1bP+q544e\x1b\\', 'Continue? [Y/n] ']))?.text).toBe('Continue? [Y/n]')
  })

  it('finds a prompt followed by CRLF blank lines', () => {
    expect(pendingPrompt(terminalText(['Name: \r\n\r\n']))?.text).toBe('Name:')
  })

  it('finds nothing once a spinner overwrites the prompt', () => {
    expect(pendingPrompt(terminalText(['Name: demo\r\n', '\x1b[2K\r⠋ Creating project']))).toBeNull()
  })
})
