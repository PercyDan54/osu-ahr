"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryRepository = void 0;
const TypedEvent_1 = require("../libs/TypedEvent");
const HistoryFetcher_1 = require("./HistoryFetcher");
const Loggers_1 = require("../Loggers");
class HistoryRepository {
    constructor(lobbyId, fetcher = null) {
        this.matchInfo = null;
        this.lobbyName = '';
        this.latestEventId = 0;
        this.oldestEventId = Number.MAX_VALUE;
        this.currentGameEventId = 0;
        this.lobbyClosed = false;
        // Events
        this.gotUserProfile = new TypedEvent_1.TypedEvent();
        this.changedLobbyName = new TypedEvent_1.TypedEvent();
        this.kickedUser = new TypedEvent_1.TypedEvent();
        this.finishedGame = new TypedEvent_1.TypedEvent();
        this.hasError = false;
        this.errorCount = 0;
        this.fetchTask = Promise.resolve({ count: 0, filled: true, isRewind: false });
        this.lobbyId = lobbyId;
        this.logger = (0, Loggers_1.getLogger)('his_repo');
        this.logger.addContext('channel', lobbyId);
        this.users = {};
        this.events = [];
        this.fetcher = fetcher ?? new HistoryFetcher_1.HistoryFecher();
    }
    setLobbyId(lobbyId) {
        this.lobbyId = parseInt(lobbyId);
        this.logger.addContext('channel', lobbyId);
    }
    /**
     * 現在の最新イベントからサーバー上の最新イベントまで更新する。
     * 初回実行時は100個のイベントが取得される。
     */
    async updateToLatest() {
        if (this.hasError)
            return;
        try {
            while (!(await this.fetch(false)).filled && !this.lobbyClosed)
                ;
        }
        catch (e) {
            if (e instanceof Error) {
                this.logger.error(`@HistoryRepository#updateToLatest\n${e.message}\n${e.stack}`);
            }
            else {
                this.logger.error(`@HistoryRepository#updateToLatest\n${e}`);
            }
            this.hasError = true;
            if (this.errorCount++ < HistoryRepository.ERR_COUNT_LIMIT) {
                setTimeout(() => {
                    this.hasError = false;
                    this.logger.info(`Restarted fetching. Count: ${this.errorCount}`);
                }, HistoryRepository.RETRY_TIME_MS);
            }
        }
    }
    /**
     * ヒストリーを取得する
     * 現在の未取得分の
     * すでに所得中の場合は、取得が完了するまで待ち、さらにクールタイム分待機したあとに次のタスクを実行する
     * @param isRewind 取得済み分の過去イベントを取得する場合はtrue,未来イベントを取得する場合はfalse
     * @returns
     */
    async fetch(isRewind = false) {
        await this.fetchTask;
        const p = this.fetch_(isRewind);
        if (HistoryRepository.COOL_TIME) {
            this.fetchTask = p.catch((e) => { return { isRewind, count: 0, filled: false }; }).then(r => new Promise((resolve) => {
                setTimeout(() => resolve(r), HistoryRepository.COOL_TIME);
            }));
        }
        else {
            this.fetchTask = p;
        }
        return p;
    }
    async fetch_(isRewind = false) {
        if (this.lobbyId === 0)
            return { count: 0, filled: true, isRewind };
        const limit = 100;
        let after = null;
        let before = null;
        if (this.events.length !== 0) {
            if (isRewind) {
                before = this.oldestEventId;
            }
            else {
                after = this.currentGameEventId ? (this.currentGameEventId - 1) : this.latestEventId;
            }
        }
        let data = null;
        try {
            data = await this.fetcher.fetchHistory(limit, before, after, this.lobbyId);
        }
        catch (e) {
            throw e;
        }
        const r = this.loadHistory(data, isRewind);
        return r;
    }
    /**
     * ヒストリーデータを取り込む
     * まだ読み込む余地がある場合trueを返す
     * 前提条件：取得するイベント範囲は現在取り込まれている範囲と重複しないこと
     * 新しいユーザープロフィールが読み込まれた場合 gotUserProfile を発生させる
     * ロビー名が変更されていた場合 changedLobbyName を発生させる
     * @param data ヒストリーデータ
     * @param isRewind 取り込み済みより前のデータを取り込むかどうか
     */
    loadHistory(data, isRewind) {
        if (!data || !data.events || !data.events.length)
            return { count: 0, filled: true, isRewind };
        if (!this.matchInfo) {
            this.matchInfo = data.match;
            this.lobbyName = data.match.name;
        }
        let newEvents = data.events;
        if (this.events.length === 0) {
            this.events = data.events;
            this.oldestEventId = data.events[0].id;
            this.latestEventId = data.events[data.events.length - 1].id;
        }
        else if (isRewind) {
            this.oldestEventId = data.events[0].id;
            this.events = data.events.concat(this.events);
        }
        else {
            newEvents = this.currentGameEventId ? data.events.filter(v => this.latestEventId < v.id) : data.events;
            newEvents.forEach(e => {
                this.events.push(e);
            });
            this.latestEventId = data.events[data.events.length - 1].id;
        }
        data.users.forEach(u => {
            const isNewComer = !(u.id in this.users);
            this.users[u.id] = u; // データは毎回必ず更新する
            if (isNewComer) {
                this.gotUserProfile.emit({ sender: this, user: u });
            }
        });
        for (const ev of newEvents) {
            switch (ev.detail.type) {
                case 'other':
                    this.checkLobbyName(ev);
                    if (ev.game) {
                        if (ev.game.end_time) {
                            this.raiseFinishedGame(ev);
                        }
                        else {
                            this.currentGameEventId = ev.id;
                        }
                    }
                    break;
                case 'player-kicked':
                    this.raiseKickedEvent(ev);
                    break;
            }
        }
        if (this.currentGameEventId) {
            const matchEvt = data.events.find(v => v.id === this.currentGameEventId);
            if (matchEvt?.game?.end_time) {
                this.raiseFinishedGame(matchEvt);
                this.currentGameEventId = 0;
            }
        }
        //this.logger.trace(`loaded ${data.events.length} events`);
        // 巻き戻しなら部屋作成イベントでfalse,
        // 前進なら最新イベントと一致でfalse
        return {
            isRewind,
            count: data.events.length,
            filled: isRewind
                ? this.events[0].detail.type === 'match-created'
                : this.latestEventId === data.latest_event_id
        };
    }
    checkLobbyName(ev) {
        if (ev.detail.text && ev.detail.text !== this.lobbyName) {
            const newName = ev.detail.text;
            const oldName = this.lobbyName;
            this.lobbyName = newName;
            const elapsedMs = Date.now() - Date.parse(ev.timestamp);
            this.changedLobbyName.emit({ sender: this, elapsedMs, oldName, newName });
        }
    }
    raiseKickedEvent(ev) {
        if (ev.user_id) {
            const kickedUser = this.users[ev.user_id];
            if (kickedUser) {
                const elapsedMs = Date.now() - Date.parse(ev.timestamp);
                this.kickedUser.emit({ sender: this, elapsedMs, kickedUser });
            }
        }
    }
    raiseFinishedGame(ev) {
        if (ev.game && ev.game.end_time) {
            const elapsedMs = Date.now() - Date.parse(ev.game.end_time);
            this.finishedGame.emit({ sender: this, elapsedMs, game: ev.game });
        }
    }
    /**
     * プレイヤーのホスト順を計算し、結果を名前で出力する。
     */
    async calcCurrentOrderAsName() {
        return (await this.calcCurrentOrderAsID()).filter(id => id in this.users).map(id => this.users[id].username);
    }
    /**
     * プレイヤーのホスト順を計算し、結果をIDで出力する。
     * ヒストリーの新しい方から順番に解析していく。
     * プレイヤーは参加時のイベントIDか自分がホストのときの試合開始時のイベントIDをageとして記録する
     * ageが若いプレイヤーほど早くホスト順が回ってくる。
     * 最初のhostchangeイベントを検知したとき、試合中なら試合開始イベントIDがageになり、試合外ならageは-1になる。
     * 2回目以降のhostchangeイベントでは一つ前のhostchangeイベントIDか、一つ前の試合開始イベントのIDがageになる。
     * !! 1秒以内に発生したイベントは順番が保証されない模様
     */
    async calcCurrentOrderAsID() {
        this.hasError = false;
        await this.updateToLatest();
        const map = {}; // 確認されたプレイヤー一覧、ロビー離席済みはtrue
        const result = [];
        if (this.events.length === 0)
            return [];
        let i = this.events.length;
        let loopCount = 0;
        let hostAge = -1; // 現在のホスト
        let gameCount = 0; // 現在までの試合数
        const unresolvedPlayers = new Set(); // 試合に参加したがまだ順番が確定していないプレイヤー
        while (true) {
            i--;
            loopCount++;
            if (i < 0) {
                // 巻き戻し
                try {
                    const r = await this.fetch(true);
                    if (r.count === 0)
                        break; // 結果が空なら終わり
                    i = r.count - 1;
                }
                catch (e) {
                    this.logger.error(`@HistoryRepository#calcCurrentOrderAsID\n${e.message}\n${e.stack}`);
                    throw e;
                }
            }
            const ev = this.events[i];
            if (ev.user_id) {
                switch (ev.detail.type) {
                    case 'host-changed':
                        // clearhost実行時に id = 0
                        if (ev.user_id !== 0 && !(ev.user_id in map)) {
                            map[ev.user_id] = false;
                            // -1、直前の試合開始ID、直前のhostchangeIDのいずれか
                            //this.logger.trace(`The host has been changed. Player ${this.users[ev.user_id].username}, Host's age: ${hostAge}`);
                            result.push({ age: hostAge, id: ev.user_id });
                        }
                        hostAge = Date.parse(ev.timestamp);
                        unresolvedPlayers.delete(ev.user_id);
                        break;
                    case 'match-created':
                        break;
                    case 'player-joined':
                        if (!(ev.user_id in map)) {
                            const la = Date.parse(ev.timestamp);
                            map[ev.user_id] = false;
                            //this.logger.trace(`A player has joined: ${this.users[ev.user_id].username}, Date(ms): ${la}`);
                            result.push({ age: la, id: ev.user_id });
                            unresolvedPlayers.delete(ev.user_id);
                        }
                        break;
                    case 'player-left':
                    case 'player-kicked':
                        if (!(ev.user_id in map)) {
                            map[ev.user_id] = true;
                            unresolvedPlayers.delete(ev.user_id);
                        }
                        break;
                    default:
                        this.logger.warn(`Detected an unknown event type:\n${JSON.stringify(ev, null, 2)}`);
                        break;
                }
            }
            else if (ev.detail.type === 'other' && ev.game) {
                hostAge = Date.parse(ev.game.start_time);
                //this.logger.trace(`set host age ${hostAge} bc game start`);
                if (ev.game.scores && gameCount < HistoryRepository.ESC_CRITERIA) {
                    gameCount++;
                    for (const s of ev.game.scores) {
                        if (!(s.user_id in map)) {
                            unresolvedPlayers.add(s.user_id);
                        }
                    }
                }
            }
            // 次の条件で全員発見したこととする
            //  参加人数が16人になった
            //  直近{ESC_CRITERIA}回の試合参加メンバーすべての存在が確認された
            //  ロビー作成イベントまで到達
            // ループリミットを超過
            if (result.length >= 16 && unresolvedPlayers.size === 0) {
                this.logger.info(`Found a total of ${result.length} players in ${loopCount} events. The lobby is full.`);
                if (result.length > 16) {
                    this.logger.warn('Found more than 16 players in the lobby. Lots of players!');
                }
                break;
            }
            if (HistoryRepository.ESC_CRITERIA <= gameCount && unresolvedPlayers.size === 0) {
                this.logger.info(`Found an estimated total of ${result.length} players in ${loopCount} events.`);
                break;
            }
            if (ev.detail.type === 'match-created') {
                this.logger.info(`Detected a match creation. Found a total of ${result.length} players in ${loopCount} events.`);
                break;
            }
            if (HistoryRepository.LOOP_LIMIT < loopCount) {
                this.logger.warn(`The loop limit has been exceeded! Loop limit: ${HistoryRepository.LOOP_LIMIT}`);
                break;
            }
            if (this.lobbyClosed) {
                this.logger.warn('The lobby has been closed abruptly.');
                result.length = 0;
                break;
            }
        }
        result.sort((a, b) => a.age - b.age);
        return result.map(a => a.id);
    }
    /**
     * イベントキャッシュをすべて削除する
     */
    async clearCache() {
        await this.fetchTask;
        this.events = [];
        this.users = {};
    }
}
exports.HistoryRepository = HistoryRepository;
HistoryRepository.ESC_CRITERIA = 6; // プレイヤー存在確認に利用する試合数
HistoryRepository.LOOP_LIMIT = 10000; // 検索イベント数の上限
HistoryRepository.ERR_COUNT_LIMIT = 10;
HistoryRepository.COOL_TIME = 100;
HistoryRepository.RETRY_TIME_MS = 10 * 60 * 1000; // 取得失敗からリトライまでの待ち時間
//# sourceMappingURL=HistoryRepository.js.map