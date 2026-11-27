use super::*;
use crate::engine::{is_engine_version, pick_engine, EngineCandidate};
use serde_json::json;

fn scratch(name: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "lw-host-test-{name}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// --- the server's lines ----------------------------------------------------

#[test]
fn the_ready_line_is_read_with_and_without_a_first_key() {
    let first = r#"{"ok":true,"version":"3.0.0","ticket":"endpointabc","notes":["model_not_configured","recall_off"],"first_key":{"room":"main","key":"k-first"}}"#;
    let Some(ServerLine::Ready(ready)) = parse_server_line(first) else {
        panic!("not read as ready")
    };
    assert_eq!(ready.ticket, "endpointabc");
    assert_eq!(ready.version, "3.0.0");
    assert_eq!(ready.notes, ["model_not_configured", "recall_off"]);
    assert_eq!(
        ready.first_key,
        Some(("main".to_owned(), "k-first".to_owned()))
    );

    let again = r#"{"ok":true,"version":"3.0.0","ticket":"endpointabc","notes":[]}"#;
    let Some(ServerLine::Ready(ready)) = parse_server_line(again) else {
        panic!("not read as ready")
    };
    assert_eq!(ready.first_key, None);
    assert!(ready.notes.is_empty());
}

#[test]
fn a_refusal_is_read_with_its_code_and_problems() {
    let line = r#"{"ok":false,"code":"bad_settings","problems":[{"variable":"TRPG_LLM__API_KEY","problem":"missing"}]}"#;
    let Some(ServerLine::Refusal(refusal)) = parse_server_line(line) else {
        panic!("not read as a refusal")
    };
    assert_eq!(refusal.code, "bad_settings");
    assert_eq!(
        refusal.problems,
        [ConfigProblem {
            variable: "TRPG_LLM__API_KEY".to_owned(),
            problem: "missing".to_owned()
        }]
    );
    let Some(ServerLine::Refusal(bare)) =
        parse_server_line(r#"{"ok":false,"code":"review_wordlist_missing"}"#)
    else {
        panic!("not read as a refusal")
    };
    assert_eq!(bare.code, "review_wordlist_missing");
    assert!(bare.problems.is_empty());
    assert_eq!(bare.detail, None);
    let Some(ServerLine::Refusal(in_use)) =
        parse_server_line(r#"{"ok":false,"code":"data_dir_in_use"}"#)
    else {
        panic!("not read as a refusal")
    };
    assert_eq!(in_use.code, "data_dir_in_use");
    let Some(ServerLine::Refusal(failed)) = parse_server_line(
        r#"{"ok":false,"code":"startup_failed","detail":"EADDRINUSE: \u001b[31maddress in use"}"#,
    ) else {
        panic!("not read as a refusal")
    };
    assert_eq!(failed.code, "startup_failed");
    assert_eq!(failed.detail.as_deref(), Some("EADDRINUSE: address in use"));
}

#[test]
fn anything_else_is_not_a_server_line() {
    for line in [
        "",
        "[main] the room woke up",
        "error: something threw",
        r#"{"ok":true,"version":"3.0.0","notes":[]}"#,
        r#"{"ok":true,"ticket":""}"#,
        r#"["ok"]"#,
        r#"{"ticket":"endpointabc"}"#,
    ] {
        assert!(parse_server_line(line).is_none(), "{line:?}");
    }
}

#[test]
fn a_report_line_loses_colour_codes_and_is_cut() {
    assert_eq!(clean_line("\u{1b}[31merror\u{1b}[0m: bad\r"), "error: bad");
    let long = "x".repeat(TAIL_LINE_CHARS + 50);
    let cut = clean_line(&long);
    assert_eq!(cut.chars().count(), TAIL_LINE_CHARS + 1);
    assert!(cut.ends_with('…'));
}

#[test]
fn a_known_key_never_reaches_a_report() {
    let secrets = vec!["s3cr3t-key-value".to_owned(), "short".to_owned()];
    assert_eq!(
        redact("minted s3cr3t-key-value for main (short)", &secrets),
        "minted [key] for main (short)"
    );
    let mut output = Output::default();
    output.push("the key is s3cr3t-key-value");
    output.secrets = secrets;
    assert_eq!(output.report(), ["the key is [key]"]);
}

#[test]
fn the_tail_keeps_only_the_last_lines() {
    let mut output = Output::default();
    for n in 0..(TAIL_LINES + 10) {
        output.push(&format!("line {n}"));
    }
    output.push("   ");
    let report = output.report();
    assert_eq!(report.len(), TAIL_LINES);
    assert_eq!(report.first().unwrap(), "line 10");
    assert_eq!(report.last().unwrap(), &format!("line {}", TAIL_LINES + 9));
}

#[tokio::test]
async fn a_line_that_never_ends_is_cut_and_reading_goes_on() {
    let mut text = "a".repeat(100);
    text.push_str("\nnext\nlast");
    let mut reader = BufReader::with_capacity(16, std::io::Cursor::new(text.into_bytes()));
    let mut buf = Vec::new();
    let mut lines = Vec::new();
    while let Some(()) = read_line_capped(&mut reader, 10, &mut buf).await.unwrap() {
        lines.push(String::from_utf8(buf.clone()).unwrap());
    }
    assert_eq!(lines, ["aaaaaaaaaa", "next", "last"]);
}

// --- what crosses to the WebView ---------------------------------------------

#[test]
fn the_exit_event_serializes_with_camel_case_fields() {
    // The 2.x enum used `rename_all` on the enum, which renames variants, not
    // fields — `host_id` went out as `host_id` while TypeScript read `hostId`.
    let event = HostExited {
        host_id: "host-1".to_owned(),
        code: Some(3),
        stderr: vec!["boom".to_owned()],
    };
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        json!({"hostId": "host-1", "code": 3, "stderr": ["boom"]})
    );
    let killed = HostExited {
        host_id: "host-2".to_owned(),
        code: None,
        stderr: Vec::new(),
    };
    assert_eq!(
        serde_json::to_value(&killed).unwrap(),
        json!({"hostId": "host-2", "code": null, "stderr": []})
    );
}

#[test]
fn a_failure_serializes_as_its_code_with_camel_case_fields() {
    let cases = [
        (
            HostFailure::Refused {
                refusal: "bad_settings".to_owned(),
                problems: vec![ConfigProblem {
                    variable: "TRPG_LLM__CHAT_MODEL".to_owned(),
                    problem: "missing".to_owned(),
                }],
                detail: None,
            },
            json!({"code": "refused", "refusal": "bad_settings", "problems": [{"variable": "TRPG_LLM__CHAT_MODEL", "problem": "missing"}], "detail": null}),
        ),
        (
            HostFailure::Refused {
                refusal: "startup_failed".to_owned(),
                problems: vec![],
                detail: Some("bind failed".to_owned()),
            },
            json!({"code": "refused", "refusal": "startup_failed", "problems": [], "detail": "bind failed"}),
        ),
        (
            HostFailure::Exited {
                exit_code: Some(1),
                stderr: vec!["x".to_owned()],
            },
            json!({"code": "exited", "exitCode": 1, "stderr": ["x"]}),
        ),
        (
            HostFailure::AlreadyRunning {
                data_dir: "/d".to_owned(),
            },
            json!({"code": "already_running", "dataDir": "/d"}),
        ),
        (
            HostFailure::NoEngine {
                engines: vec![EngineProblem {
                    kind: "checkout".to_owned(),
                    program: "bun".to_owned(),
                    problem: "spawning bun failed".to_owned(),
                }],
            },
            json!({"code": "no_engine", "engines": [{"kind": "checkout", "program": "bun", "problem": "spawning bun failed"}]}),
        ),
        (
            HostFailure::MintFailed {
                refusal: None,
                stderr: vec![],
            },
            json!({"code": "mint_failed", "refusal": null, "stderr": []}),
        ),
        (
            HostFailure::Timeout { stderr: vec![] },
            json!({"code": "timeout", "stderr": []}),
        ),
        (HostFailure::Cancelled, json!({"code": "cancelled"})),
        (HostFailure::NoKey, json!({"code": "no_key"})),
        (
            HostFailure::Io {
                detail: "d".to_owned(),
            },
            json!({"code": "io", "detail": "d"}),
        ),
    ];
    for (failure, expected) in cases {
        assert_eq!(serde_json::to_value(&failure).unwrap(), expected);
    }
}

#[test]
fn a_ready_serializes_in_camel_case_and_its_debug_hides_the_key() {
    let ready = HostReady {
        host_id: "host-1".to_owned(),
        ticket: "endpointabc".to_owned(),
        key: "the-admin-key-value".to_owned(),
        room: "main".to_owned(),
        key_source: KeySource::First,
        notes: vec!["model_not_configured".to_owned()],
        version: "3.0.0".to_owned(),
        data_dir: "/d".to_owned(),
        network: NetworkProfile::N0,
        reused: false,
    };
    assert_eq!(
        serde_json::to_value(&ready).unwrap(),
        json!({
            "hostId": "host-1", "ticket": "endpointabc", "key": "the-admin-key-value",
            "room": "main", "keySource": "first", "notes": ["model_not_configured"],
            "version": "3.0.0", "dataDir": "/d", "network": "n0", "reused": false
        })
    );
    assert!(!format!("{ready:?}").contains("the-admin-key-value"));
    assert_eq!(serde_json::to_value(KeySource::Minted).unwrap(), "minted");
    assert_eq!(serde_json::to_value(KeySource::Kept).unwrap(), "kept");
    let on_loopback = HostReady {
        network: NetworkProfile::Local,
        ..ready
    };
    assert_eq!(
        serde_json::to_value(&on_loopback).unwrap()["network"],
        "local"
    );
}

// --- paths, keys, the command line -------------------------------------------

#[test]
fn the_home_is_the_picked_folder_or_local_server_in_the_app_data_folder() {
    let app = Path::new("/app-data");
    let default = resolve_paths(app, None);
    assert_eq!(default.home, app.join("local-server"));
    assert_eq!(default.data_dir, app.join("local-server").join("data"));
    assert_eq!(default.keys_file, app.join("local-server-keys.json"));
    assert_eq!(resolve_paths(app, Some("   ")), default);
    let picked = resolve_paths(app, Some(" /srv/lw "));
    assert_eq!(picked.home, PathBuf::from("/srv/lw"));
    assert_eq!(picked.data_dir, PathBuf::from("/srv/lw").join("data"));
    // The kept keys stay in the app's own folder, wherever the server lives.
    assert_eq!(picked.keys_file, app.join("local-server-keys.json"));
}

#[test]
fn a_kept_key_belongs_to_its_data_directory() {
    let dir = scratch("keys");
    let file = dir.join("app").join(KEPT_KEYS_FILE);
    let one = dir.join("one");
    let two = dir.join("two");
    std::fs::create_dir_all(&one).unwrap();
    assert_eq!(kept_key(&file, &one), None);
    keep_key(&file, &one, "main", "key-one").unwrap();
    keep_key(&file, &two, "main", "key-two").unwrap();
    assert_eq!(
        kept_key(&file, &one),
        Some(("main".to_owned(), "key-one".to_owned()))
    );
    keep_key(&file, &one, "main", "key-one-b").unwrap();
    assert_eq!(kept_key(&file, &one).unwrap().1, "key-one-b");
    assert_eq!(kept_key(&file, &two).unwrap().1, "key-two");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the kept keys are the owner's alone");
    }
    assert!(forget_key(&file, &one).unwrap());
    assert!(!forget_key(&file, &one).unwrap());
    assert_eq!(kept_key(&file, &one), None);
    assert_eq!(kept_key(&file, &two).unwrap().1, "key-two");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_loopback_option_adds_local_before_the_stdin_flag_and_nothing_else() {
    let engine = EngineCommand {
        program: "loreweaver".to_owned(),
        args: Vec::new(),
    };
    let args = |network| -> Vec<String> {
        serve_command(&engine, Path::new("/run"), Path::new("/data"), &[], network)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    };
    assert_eq!(args(NetworkProfile::N0), ["serve", "--until-stdin-closes"]);
    assert_eq!(
        args(NetworkProfile::Local),
        ["serve", "--local", "--until-stdin-closes"]
    );
}

#[test]
fn the_command_line_carries_no_value_and_the_callers_trpg_settings_are_dropped() {
    // A TRPG_* variable in this app's own environment must not reach the server.
    std::env::set_var("TRPG_STUDIO_HOST_TEST_LEAK", "leak");
    let engine = EngineCommand {
        program: "bun".to_owned(),
        args: vec!["/engine/server/src/cli/main.ts".to_owned()],
    };
    let env = vec![
        ("TRPG_LOCALE".to_owned(), "zh".to_owned()),
        (
            "TRPG_LLM__API_KEY".to_owned(),
            "sk-sentinel-secret".to_owned(),
        ),
    ];
    let command = serve_command(
        &engine,
        Path::new("/run"),
        Path::new("/data"),
        &env,
        NetworkProfile::N0,
    );
    let std = command.as_std();
    assert_eq!(std.get_program(), "bun");
    let args: Vec<_> = std
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    // The product path: reachable over the relays, no loopback flag.
    assert_eq!(
        args,
        [
            "/engine/server/src/cli/main.ts",
            "serve",
            "--until-stdin-closes"
        ]
    );
    assert!(!args.iter().any(|arg| arg.contains("sk-sentinel-secret")));
    assert_eq!(std.get_current_dir(), Some(Path::new("/run")));
    let envs: Vec<(String, Option<String>)> = std
        .get_envs()
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    let get = |name: &str| envs.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    assert_eq!(get("TRPG_STUDIO_HOST_TEST_LEAK"), Some(None), "removed");
    assert_eq!(get("TRPG_DATA_DIR"), Some(Some("/data".to_owned())));
    assert_eq!(get("TRPG_LOCALE"), Some(Some("zh".to_owned())));
    assert_eq!(
        get("TRPG_LLM__API_KEY"),
        Some(Some("sk-sentinel-secret".to_owned())),
        "a value goes in the environment"
    );
    std::env::remove_var("TRPG_STUDIO_HOST_TEST_LEAK");
}

#[test]
fn the_server_language_is_the_apps_when_the_server_speaks_it() {
    assert_eq!(
        locale_env(Some("zh")),
        [("TRPG_LOCALE".to_owned(), "zh".to_owned())]
    );
    assert!(locale_env(Some("fr")).is_empty());
    assert!(locale_env(None).is_empty());
}

#[test]
fn only_an_engine_that_answers_like_3_x_is_picked() {
    assert!(is_engine_version("3.0.0"));
    assert!(is_engine_version(" 3.12.1-dev\n"));
    assert!(!is_engine_version("2.6.0"));
    assert!(!is_engine_version("3"));
    assert!(!is_engine_version("\u{1b}[?2031h garbage"));
    let candidate = |kind: &str, version: Option<&str>| EngineCandidate {
        kind: kind.to_owned(),
        program: kind.to_owned(),
        args: Vec::new(),
        cwd: None,
        version: version.map(str::to_owned),
        problem: None,
    };
    let list = [
        candidate("binary", Some("\u{1b}[?25l a terminal app")),
        candidate("checkout", Some("3.0.0")),
    ];
    assert_eq!(pick_engine(&list).unwrap().kind, "checkout");
    assert!(pick_engine(&[candidate("binary", None)]).is_none());
}

// --- the process, with a stand-in engine --------------------------------------

#[cfg(unix)]
mod process {
    use super::*;

    /// A stand-in for the engine: `sh fake.sh <subcommand…>`, its behaviour
    /// picked by `FAKE_MODE` in the settings the start passes on. A `serve`
    /// refuses to run unless its arguments are `FAKE_ARGS`.
    const FAKE: &str = r#"
if [ "$1" = "key" ]; then
  printf '{"ok":true,"key":"minted-key-0123456789","id":"k1"}\n'
  exit 0
fi
# The arguments the start passed are exactly what the test expects (`FAKE_ARGS`),
# and are kept for it to read back.
[ "$*" = "$FAKE_ARGS" ] || { echo "bad args: $*" >&2; exit 9; }
echo "$*" > "$TRPG_DATA_DIR/serve-args"
first() {
  if [ -f "$TRPG_DATA_DIR/keys.json" ]; then echo ""; else
    echo '{}' > "$TRPG_DATA_DIR/keys.json"
    echo ',"first_key":{"room":"main","key":"first-key-0123456789"}'
  fi
}
case "$FAKE_MODE" in
  ready)
    echo "[main] warming up" >&2
    printf '{"ok":true,"version":"3.0.0","ticket":"endpointfake","notes":["model_not_configured"]%s}\n' "$(first)"
    exec sleep 30 ;;
  refuse)
    printf '{"ok":false,"code":"bad_settings","problems":[{"variable":"TRPG_LLM__API_KEY","problem":"missing"}]}\n' >&2
    exit 2 ;;
  in_use)
    printf '{"ok":false,"code":"data_dir_in_use"}\n' >&2
    exit 2 ;;
  stdin)
    # What `--until-stdin-closes` does: run until standard input ends, then stop.
    printf '{"ok":true,"version":"3.0.0","ticket":"endpointfake","notes":[]%s}\n' "$(first)"
    cat > /dev/null
    echo closed > "$TRPG_DATA_DIR/stdin-closed"
    exit 0 ;;
  crash)
    echo "boom while holding kept-key-0123456789" >&2
    echo "second line" >&2
    exit 3 ;;
  env)
    echo "data=$TRPG_DATA_DIR leak=${TRPG_STUDIO_FAKE_LEAK:-none} cwd=$(pwd)" >&2
    exit 4 ;;
  hang)
    exec sleep 30 ;;
  die)
    printf '{"ok":true,"version":"3.0.0","ticket":"endpointfake","notes":[]%s}\n' "$(first)"
    sleep 0.3
    echo "fatal: the store went away" >&2
    exit 7 ;;
esac
"#;

    struct Rig {
        dir: PathBuf,
        host: Arc<LocalHost>,
        engine: EngineCommand,
    }

    impl Rig {
        fn new(name: &str) -> Self {
            let dir = scratch(name);
            let script = dir.join("fake.sh");
            std::fs::write(&script, FAKE).unwrap();
            Self {
                engine: EngineCommand {
                    program: "sh".to_owned(),
                    args: vec![script.to_string_lossy().into_owned()],
                },
                host: Arc::new(LocalHost::default()),
                dir,
            }
        }

        fn paths(&self, home: &str) -> HostPaths {
            resolve_paths(
                &self.dir.join("app"),
                Some(&self.dir.join(home).to_string_lossy()),
            )
        }

        /// The product path: the relays, `serve --until-stdin-closes`.
        fn config(&self, mode: &str, home: &str, timeout: Duration) -> HostConfig {
            self.config_on(mode, home, timeout, NetworkProfile::N0)
        }

        fn config_on(
            &self,
            mode: &str,
            home: &str,
            timeout: Duration,
            network: NetworkProfile,
        ) -> HostConfig {
            // Spelt out here, not taken from the code under test.
            let args = match network {
                NetworkProfile::N0 => "serve --until-stdin-closes",
                NetworkProfile::Local => "serve --local --until-stdin-closes",
            };
            HostConfig {
                paths: self.paths(home),
                env: vec![
                    ("FAKE_MODE".to_owned(), mode.to_owned()),
                    ("FAKE_ARGS".to_owned(), args.to_owned()),
                ],
                ready_timeout: timeout,
                network,
            }
        }

        async fn start(&self, mode: &str) -> Result<HostReady, HostFailure> {
            self.start_with(mode, "home", |_| {}).await
        }

        async fn start_with(
            &self,
            mode: &str,
            home: &str,
            on_exit: impl FnOnce(HostExited) + Send + 'static,
        ) -> Result<HostReady, HostFailure> {
            let engine = self.engine.clone();
            self.host
                .start(
                    self.config(mode, home, Duration::from_secs(10)),
                    async move { Ok(engine) },
                    on_exit,
                )
                .await
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn first_start_keeps_the_first_key_then_stop_leaves_no_process() {
        let rig = Rig::new("first");
        let ready = rig.start("ready").await.expect("ready");
        assert_eq!(ready.ticket, "endpointfake");
        assert_eq!(ready.key, "first-key-0123456789");
        assert_eq!(ready.room, "main");
        assert_eq!(ready.key_source, KeySource::First);
        assert_eq!(ready.notes, ["model_not_configured"]);
        assert!(!ready.reused);
        let paths = rig.paths("home");
        assert_eq!(
            kept_key(&paths.keys_file, &paths.data_dir),
            Some(("main".to_owned(), "first-key-0123456789".to_owned()))
        );
        let pid = rig.host.pid().expect("a pid");
        assert!(alive(pid));
        assert!(rig.host.stop().await);
        assert!(!alive(pid), "the server is gone once stop returns");
        assert!(rig.host.running().is_none());
        assert!(!rig.host.stop().await, "nothing left to stop");
    }

    #[tokio::test]
    async fn the_product_path_serves_over_the_relays_and_reports_the_normal_dial_profile() {
        let rig = Rig::new("n0");
        let ready = rig.start("ready").await.expect("ready");
        assert_eq!(ready.network, NetworkProfile::N0);
        let args = std::fs::read_to_string(rig.paths("home").data_dir.join("serve-args")).unwrap();
        assert_eq!(args.trim(), "serve --until-stdin-closes");
        // Sitting down again at the running server gets the same answer.
        let again = rig.start("ready").await.expect("reused");
        assert!(again.reused);
        assert_eq!(again.network, NetworkProfile::N0);
        rig.host.stop().await;
    }

    #[tokio::test]
    async fn the_test_only_loopback_option_runs_serve_local_and_reports_the_local_profile() {
        let rig = Rig::new("loopback");
        let engine = rig.engine.clone();
        let ready = rig
            .host
            .start(
                rig.config_on(
                    "ready",
                    "home",
                    Duration::from_secs(10),
                    NetworkProfile::Local,
                ),
                async move { Ok(engine) },
                |_| {},
            )
            .await
            .expect("ready");
        assert_eq!(ready.network, NetworkProfile::Local);
        let args = std::fs::read_to_string(rig.paths("home").data_dir.join("serve-args")).unwrap();
        assert_eq!(args.trim(), "serve --local --until-stdin-closes");
        rig.host.stop().await;
    }

    #[tokio::test]
    async fn a_second_run_uses_the_kept_key_and_a_lost_one_is_minted() {
        let rig = Rig::new("second");
        rig.start("ready").await.expect("first run");
        rig.host.stop().await;
        let again = rig.start("ready").await.expect("second run");
        assert_eq!(again.key_source, KeySource::Kept);
        assert_eq!(again.key, "first-key-0123456789");
        rig.host.stop().await;

        let paths = rig.paths("home");
        assert!(forget_key(&paths.keys_file, &paths.data_dir).unwrap());
        let minted = rig.start("ready").await.expect("third run");
        assert_eq!(minted.key_source, KeySource::Minted);
        assert_eq!(minted.key, "minted-key-0123456789");
        assert_eq!(
            kept_key(&paths.keys_file, &paths.data_dir).unwrap().1,
            "minted-key-0123456789"
        );
        rig.host.stop().await;
    }

    #[tokio::test]
    async fn starting_again_sits_back_down_and_another_folder_is_refused() {
        let rig = Rig::new("reuse");
        let first = rig.start("ready").await.expect("ready");
        let again = rig.start("ready").await.expect("reused");
        assert!(again.reused);
        assert_eq!(again.host_id, first.host_id);
        assert_eq!(again.key, first.key);
        let other = rig.start_with("ready", "elsewhere", |_| {}).await;
        assert!(
            matches!(other, Err(HostFailure::AlreadyRunning { ref data_dir }) if data_dir.ends_with("data")),
            "{other:?}"
        );
        rig.host.stop().await;
    }

    #[tokio::test]
    async fn a_refusal_is_answered_with_its_code_and_problems() {
        let rig = Rig::new("refuse");
        let failure = rig.start("refuse").await.unwrap_err();
        assert_eq!(
            failure,
            HostFailure::Refused {
                refusal: "bad_settings".to_owned(),
                problems: vec![ConfigProblem {
                    variable: "TRPG_LLM__API_KEY".to_owned(),
                    problem: "missing".to_owned()
                }],
                detail: None,
            }
        );
        assert!(rig.host.running().is_none());
        let in_use = rig.start("in_use").await.unwrap_err();
        assert_eq!(
            in_use,
            HostFailure::Refused {
                refusal: "data_dir_in_use".to_owned(),
                problems: vec![],
                detail: None,
            }
        );
    }

    async fn gone(pid: u32) -> bool {
        for _ in 0..100 {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn the_input_pipe_is_held_while_hosting_and_closes_with_the_host() {
        let rig = Rig::new("stdin");
        let marker = rig.paths("home").data_dir.join("stdin-closed");
        // A host of its own, so this test holds its only strong reference.
        let host = Arc::new(LocalHost::default());
        let engine = rig.engine.clone();
        host.start(
            rig.config("stdin", "home", Duration::from_secs(10)),
            async move { Ok(engine) },
            |_| {},
        )
        .await
        .expect("ready");
        let pid = host.pid().expect("a pid");
        // Held: the server is still reading its input a while later.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(alive(pid), "the server must keep running while hosted");
        assert!(!marker.exists(), "its input must not have ended");

        // The host goes away without stopping anything (what a crash does to
        // the app): its end of the pipe closes, and the server stops by itself.
        drop(host);
        assert!(gone(pid).await, "the server must stop when the pipe ends");
        assert!(marker.exists(), "it stopped because its input ended");
    }

    #[tokio::test]
    async fn stopping_a_server_that_waits_on_its_input_leaves_no_process() {
        let rig = Rig::new("stdin-stop");
        rig.start("stdin").await.expect("ready");
        let pid = rig.host.pid().expect("a pid");
        assert!(rig.host.stop().await);
        assert!(gone(pid).await);
        assert!(rig.host.running().is_none());
    }

    #[tokio::test]
    async fn an_early_exit_reports_the_last_lines_without_the_key() {
        let rig = Rig::new("crash");
        let paths = rig.paths("home");
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        keep_key(
            &paths.keys_file,
            &paths.data_dir,
            "main",
            "kept-key-0123456789",
        )
        .unwrap();
        let failure = rig.start("crash").await.unwrap_err();
        assert_eq!(
            failure,
            HostFailure::Exited {
                exit_code: Some(3),
                stderr: vec![
                    "boom while holding [key]".to_owned(),
                    "second line".to_owned()
                ],
            }
        );
    }

    #[tokio::test]
    async fn the_child_gets_the_data_dir_an_empty_cwd_and_none_of_the_callers_trpg_settings() {
        std::env::set_var("TRPG_STUDIO_FAKE_LEAK", "leaked");
        let rig = Rig::new("env");
        let failure = rig.start("env").await.unwrap_err();
        std::env::remove_var("TRPG_STUDIO_FAKE_LEAK");
        let HostFailure::Exited { stderr, .. } = failure else {
            panic!("{failure:?}")
        };
        let line = &stderr[0];
        let data = rig.paths("home").data_dir;
        assert!(line.contains(&format!("data={}", data.display())), "{line}");
        assert!(line.contains("leak=none"), "{line}");
        assert!(
            line.contains("lw-studio-host-"),
            "a working directory of its own: {line}"
        );
    }

    #[tokio::test]
    async fn no_ready_line_in_time_stops_the_server() {
        let rig = Rig::new("hang");
        let engine = rig.engine.clone();
        let failure = rig
            .host
            .start(
                rig.config("hang", "home", Duration::from_millis(300)),
                async move { Ok(engine) },
                |_| {},
            )
            .await
            .unwrap_err();
        assert!(
            matches!(failure, HostFailure::Timeout { .. }),
            "{failure:?}"
        );
        assert!(rig.host.running().is_none());
        assert!(rig.host.pid().is_none());
    }

    #[tokio::test]
    async fn stop_during_the_start_cancels_it_and_leaves_no_process() {
        let rig = Rig::new("cancel");
        let host = Arc::clone(&rig.host);
        let stopper = tokio::spawn(async move {
            // Wait for the child to be spawned, then stop.
            for _ in 0..200 {
                if let Some(pid) = host.pid() {
                    assert!(host.stop().await);
                    return pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no child was spawned");
        });
        let failure = rig.start("hang").await.unwrap_err();
        let pid = stopper.await.unwrap();
        assert_eq!(failure, HostFailure::Cancelled);
        assert!(!alive(pid));
        assert!(rig.host.running().is_none());
    }

    #[tokio::test]
    async fn stop_while_the_engine_is_still_being_found_cancels_it() {
        let rig = Rig::new("cancel-probe");
        let host = Arc::clone(&rig.host);
        let (tx, rx) = oneshot::channel::<()>();
        let engine = rig.engine.clone();
        let start = {
            let host = Arc::clone(&host);
            let config = rig.config("ready", "home", Duration::from_secs(10));
            tokio::spawn(async move {
                host.start(
                    config,
                    async move {
                        let _ = rx.await;
                        Ok(engine)
                    },
                    |_| {},
                )
                .await
            })
        };
        while host.running().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(host.stop().await);
        let _ = tx.send(());
        assert_eq!(start.await.unwrap().unwrap_err(), HostFailure::Cancelled);
        assert!(host.running().is_none());
    }

    #[tokio::test]
    async fn no_engine_is_passed_through_and_releases_the_slot() {
        let rig = Rig::new("no-engine");
        let failure = rig
            .host
            .start(
                rig.config("ready", "home", Duration::from_secs(1)),
                async { Err(HostFailure::NoEngine { engines: vec![] }) },
                |_| {},
            )
            .await
            .unwrap_err();
        assert_eq!(failure, HostFailure::NoEngine { engines: vec![] });
        assert!(rig.host.running().is_none());
    }

    #[tokio::test]
    async fn a_server_that_dies_after_ready_is_told_once_with_its_last_lines() {
        let rig = Rig::new("die");
        let (tx, rx) = oneshot::channel();
        let ready = rig
            .start_with("die", "home", move |exited| {
                let _ = tx.send(exited);
            })
            .await
            .expect("ready");
        let exited = tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .expect("told in time")
            .expect("told");
        assert_eq!(
            exited,
            HostExited {
                host_id: ready.host_id,
                code: Some(7),
                stderr: vec!["fatal: the store went away".to_owned()],
            }
        );
        assert!(rig.host.running().is_none());
    }

    #[tokio::test]
    async fn a_stopped_server_is_not_reported_as_died() {
        let rig = Rig::new("quiet");
        let told = Arc::new(Mutex::new(false));
        let flag = told.clone();
        rig.start_with("ready", "home", move |_| *lock(&flag) = true)
            .await
            .expect("ready");
        rig.host.stop().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!*lock(&told));
    }
}
