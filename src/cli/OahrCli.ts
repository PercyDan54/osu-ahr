import { IIrcClient } from '../IIrcClient';
import { LobbyStatus } from '../Lobby';
import * as readline from 'readline';
import log4js from 'log4js';
import { parser } from '../parsers/CommandParser';
import { OahrBase } from './OahrBase';

const logger = log4js.getLogger('cli');

const mainMenuCommandsMessage = `
MainMenu Commands
  [make <Lobby_name>] Make a lobby. ex: 'make 5* auto host rotation'
  [enter <LobbyID>] Enter a lobby. ex: 'enter 123456' (It will only work with a Tournament lobby ID.)
  [help] Show this message.
  [quit] Quit this application.
`;

const lobbyMenuCommandsMessage = `
LobbyMenu Commands
  [say <Message>] Send a message to #multiplayer.
  [info] Show the application's current information.
  [reorder] Arrange the host queue. ex: 'reorder player1, player2, player3'
  [regulation <regulation command>] Change one or more regulations. ex: 'regulation star_min=2 star_max=5 len_min=60 len_max=300' 
  [regulation enable] Enable regulation checking.
  [regulation disable] Disable regulation checking.
  [close] Close the lobby and quit this application. ex: 'close now'
            DO NOT Quit the application before closing the lobby!
  [quit] Quit this application. (Lobby will not close.)
`;

interface Scene {
  name: string;
  prompt: string;
  action: (line: string) => Promise<void>;
  completer: readline.Completer
}

export class OahrCli extends OahrBase {
  private scene: Scene;

  constructor(client: IIrcClient) {
    super(client);
    this.scene = this.scenes.mainMenu;
  }

  private scenes = {
    mainMenu: {
      name: '',
      prompt: '> ',
      action: async (line: string) => {
        const l = parser.SplitCliCommand(line);
        switch (l.command) {
          case 'm':
          case 'make':
            if (l.arg === '') {
              logger.info('Make command needs a lobby name. ex: make testlobby');
              return;
            }
            try {
              await this.makeLobbyAsync(l.arg);
              this.transitionToLobbyMenu();
            } catch (e) {
              logger.info('Failed to make a lobby : %s', e);
              this.scene = this.scenes.exited;
            }
            break;
          case 'e':
          case 'enter':
            try {
              if (l.arg === '') {
                logger.info('Enter command needs a lobby ID. ex: enter 123456');
                return;
              }
              await this.enterLobbyAsync(l.arg);
              this.transitionToLobbyMenu();
            } catch (e) {
              logger.info('Invalid channel : %s', e);
              this.scene = this.scenes.exited;
            }
            break;
          case 'q':
          case 'quit':
          case 'exit':
            this.scene = this.scenes.exited;
            break;
          case 'h':
          case 'help':
          case 'command':
          case 'commands':
          case '/?':
          case '-?':
          case '?':
            console.log(mainMenuCommandsMessage);
            break;
          case '':
            break;
          default:
            logger.info('Invalid command : %s', line);
            break;
        }
      },
      completer: (line: string): readline.CompleterResult => {
        const completions = ['make', 'enter', 'quit', 'exit', 'help'];
        const hits = completions.filter(v => v.startsWith(line));
        return [hits.length ? hits : ['make', 'enter', 'quit', 'help'], line];
      }
    },
    lobbyMenu: {
      name: 'lobbyMenu',
      prompt: '> ',
      action: async (line: string) => {
        const l = parser.SplitCliCommand(line);
        if (this.lobby.status === LobbyStatus.Left || !this.client.conn) {
          this.scene = this.scenes.exited;
          return;
        }
        switch (l.command) {
          case 's':
          case 'say':
            if ((l.arg.startsWith('!') && !l.arg.startsWith('!mp ')) || l.arg.startsWith('*')) {
              this.lobby.RaiseReceivedChatCommand(this.lobby.GetOrMakePlayer(this.client.nick), l.arg);
            } else {
              this.lobby.SendMessage(l.arg);
            }
            break;
          case 'i':
          case 'info':
            this.displayInfo();
            break;
          case 'reorder':
            this.selector.Reorder(l.arg);
            break;
          case 'regulation':
            if (!l.arg) {
              console.log(this.checker.getRegulationDescription());
            } else {
              this.checker.processOwnerCommand('*regulation', l.arg); // TODO check
            }
            break;
          case 'c':
          case 'close':
            if (l.arg === 'now') {
              // close now
              await this.lobby.CloseLobbyAsync();
              this.scene = this.scenes.exited;
            } else if (l.arg.match(/\d+/)) {
              // close after secs
              this.terminator.CloseLobby(parseInt(l.arg) * 1000);
            } else {
              // close after everyone leaves
              this.terminator.CloseLobby();
            }
            break;
          case 'q':
          case 'quit':
            logger.info('quit');
            this.scene = this.scenes.exited;
            break;
          case 'h':
          case 'help':
          case 'command':
          case 'commands':
          case '/?':
          case '-?':
          case '?':
            console.log(lobbyMenuCommandsMessage);
            break;
          case 'check_order':
            this.lobby.historyRepository.calcCurrentOrderAsName().then(r => {
              logger.info('History order = ' + r.join(', '));
              logger.info('Current order = ' + this.selector.hostQueue.map(p => p.name).join(', '));
            });
            break;
          case '':
            break;
          default:
            if (l.command.startsWith('!mp')) {
              this.lobby.SendMessage('!mp ' + l.arg);
            } else if (l.command.startsWith('!') || l.command.startsWith('*')) {
              this.lobby.RaiseReceivedChatCommand(this.lobby.GetOrMakePlayer(this.client.nick), l.command + ' ' + l.arg);
            } else {
              console.log('Invalid command : %s', line);
            }
            break;
        }
      },
      completer: (line: string): readline.CompleterResult => {
        const completions = ['say', 'info', 'reorder', 'regulation', 'close', 'quit', 'help'];
        const hits = completions.filter(v => v.startsWith(line));
        return [hits.length ? hits : completions, line];
      }
    },

    exited: {
      name: 'exited',
      prompt: 'ended',
      action: async (line: string) => { /* do nothing. */ },
      completer: (line: string): readline.CompleterResult => {
        return [['exit'], line];
      }
    }
  };

  get prompt(): string {
    return this.scene.prompt;
  }

  get exited(): boolean {
    return this.scene === this.scenes.exited;
  }

  start(rl: readline.Interface | null) {
    if (!rl) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: (line: string) => {
          return this.scene.completer(line);
        }
      });
    }
    const r = rl as readline.Interface;

    logger.trace('Waiting for registration from bancho');
    console.log('Connecting to Osu Bancho...');
    this.client.once('registered', () => {
      console.log('Connected :D');
      console.log('\n=== Welcome to osu-ahr ===');
      console.log(mainMenuCommandsMessage);
      r.setPrompt(this.prompt);
      r.prompt();
    });

    r.on('line', line => {
      logger.trace('Scene:%s, Line:%s', this.scene.name, line);
      this.scene.action(line).then(() => {
        if (!this.exited) {
          r.setPrompt(this.prompt);
          r.prompt();
        } else {
          logger.trace('Closing interface');
          r.close();
        }
      });
    });
    r.on('close', () => {
      if (this.client) {
        logger.info('Readline closed');
        if (this.client.conn && !this.client.conn.requestedDisconnect) {
          this.client.disconnect('Goodbye', () => {
            logger.info('ircClient disconnected');
            process.exit(0);
          });
        } else {
          logger.info('exit');
          process.exit(0);
        }
      }
    });
  }

  transitionToLobbyMenu() {
    this.scene = this.scenes.lobbyMenu;
    this.scene.prompt = (this.lobby.channel || '') + ' > ';
    console.log(lobbyMenuCommandsMessage);
  }
}
