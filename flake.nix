{
  description = "Local LLM CUDA Environment with Llama.cpp";

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
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          python311
          python311Packages.pip
          python311Packages.virtualenv
          cmake
          ninja
          stdenv.cc
          cudaPackages.cudatoolkit
          cudaPackages.cuda_nvcc
          cudaPackages.cuda_cudart
        ];

        shellHook = ''
          export CUDA_PATH=${pkgs.cudaPackages.cudatoolkit}

          # Explicitly target all sub-paths where libcudart and libstdc++ live
          export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [
            pkgs.stdenv.cc.cc.lib
            pkgs.cudaPackages.cudatoolkit
            pkgs.cudaPackages.cuda_cudart
            pkgs.linuxPackages.nvidia_x11
          ]}:${pkgs.cudaPackages.cudatoolkit}/lib64:${pkgs.cudaPackages.cudatoolkit}/lib:$LD_LIBRARY_PATH"

          # Setup local python virtual environment if missing
          if [ ! -d ".venv" ]; then
            echo "Creating Python virtual environment..."
            python -m venv .venv
          fi
          source .venv/bin/activate

          # Install pre-built CUDA wheel if not present
          if ! python -c "import llama_cpp" 2>/dev/null; then
            echo "Installing pre-built llama-cpp-python CUDA wheel..."
            pip install --no-cache-dir llama-cpp-python \
              --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124
          fi

          if ! python -c "import ddgs" 2>/dev/null; then
            echo "Installing DDGS web-search dependency..."
            pip install --no-cache-dir 'ddgs>=9.0.0'
          fi

          echo "===================================================="
          echo "CUDA Llama environment ready!"
          echo "Run the package with: python -m smartharness"
          echo "===================================================="
        '';
      };
    };
}