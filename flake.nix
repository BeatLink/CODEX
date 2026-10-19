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
      python = pkgs.python312.override {
        packageOverrides = pythonFinal: pythonPrev: {
          anyio = pythonPrev.anyio.overridePythonAttrs (_: {
            doCheck = false;
          });
        };
      };
      pythonPackages = python.pkgs;
      project = (builtins.fromTOML (builtins.readFile ./pyproject.toml)).project;
      app = pythonPackages.buildPythonApplication {
        pname = project.name;
        version = project.version;
        pyproject = true;
        src = self;
        build-system = [ pythonPackages.setuptools ];
        dependencies = [
          pythonPackages."llama-cpp-python"
          pythonPackages.ddgs
          pythonPackages.mcp
        ];
      };
      pythonEnv = python.withPackages (packages: [
        packages."llama-cpp-python"
        packages.ddgs
        packages.mcp
      ]);
    in
    {
      packages.${system} = {
        default = app;
        smartharness = app;
      };

      apps.${system}.default = {
        type = "app";
        program = "${app}/bin/smartharness";
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          app
          pythonEnv
          pkgs.cmake
          pkgs.ninja
          pkgs.stdenv.cc
          pkgs.cudaPackages.cuda_nvcc
        ];
      };
    };
}