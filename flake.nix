{
  description = "CODEX: a task-tree harness for locally run language models";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          cudaSupport = true;
        };
      };
      nodejs = pkgs.nodejs_24;
      electron = pkgs.electron;

      # node-llama-cpp's prebuilt CUDA build needs the CUDA runtime and the driver's libcuda at run time.
      runtimeLibraryPath = pkgs.lib.makeLibraryPath [
        pkgs.cudaPackages.cuda_cudart
        pkgs.cudaPackages.libcublas
        pkgs.stdenv.cc.cc.lib
      ] + ":/run/opengl-driver/lib";
      runtimePath = pkgs.lib.makeBinPath [ pkgs.util-linux ];

      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      app = pkgs.buildNpmPackage {
        pname = packageJson.name;
        version = packageJson.version;
        src = self;
        inherit nodejs;
        npmDepsHash = "sha256-JIQkx1u2JM5mWU17+nGG3KKiBZDtb2LKZZlmyBeZC9s=";
        npmFlags = [ "--ignore-scripts" ];
        # npm unpacks the RoboBuddy git dependency through the cache, so the cache must be writable.
        makeCacheWritable = true;
        env = {
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          NODE_LLAMA_CPP_SKIP_DOWNLOAD = "true";
        };
        nativeBuildInputs = [ pkgs.makeWrapper ];
        installPhase = ''
          runHook preInstall
          npm prune --omit=dev --ignore-scripts
          mkdir -p $out/lib/codex $out/bin
          cp -r dist node_modules evals share package.json $out/lib/codex/
          makeWrapper ${nodejs}/bin/node $out/bin/codex \
            --add-flags $out/lib/codex/dist/cli/index.js \
            --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
            --prefix PATH : "${runtimePath}"
          makeWrapper ${nodejs}/bin/node $out/bin/codex-daemon \
            --add-flags $out/lib/codex/dist/daemon/index.js \
            --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
            --prefix PATH : "${runtimePath}"
          makeWrapper ${electron}/bin/electron $out/bin/codex-gui \
            --add-flags $out/lib/codex/dist/main/index.js \
            --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
            --prefix PATH : "${runtimePath}" \
            --set CODEX_GUI_COMMAND $out/bin/codex-gui
          install -Dm644 share/org.codex.CODEX.desktop $out/share/applications/org.codex.CODEX.desktop
          install -Dm644 share/org.codex.CODEX.svg $out/share/icons/hicolor/scalable/apps/org.codex.CODEX.svg
          runHook postInstall
        '';
      };
    in
    {
      packages.${system} = {
        default = app;
        codex = app;
      };

      apps.${system} = {
        default = {
          type = "app";
          program = "${app}/bin/codex-gui";
        };
        cli = {
          type = "app";
          program = "${app}/bin/codex";
        };
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          nodejs
          electron
          pkgs.util-linux
        ];
        # npm scripts put node_modules/.bin first on PATH; point them at the Nix wrapper instead.
        ELECTRON = "${electron}/bin/electron";
        ELECTRON_OVERRIDE_DIST_PATH = "${electron}/libexec/electron";
        # The npm electron package runs the bare binary, which dumps core without the wrapper's sandbox path.
        CHROME_DEVEL_SANDBOX = "${electron}/libexec/electron/chrome-sandbox";
        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
        LD_LIBRARY_PATH = runtimeLibraryPath;
      };
    };
}
